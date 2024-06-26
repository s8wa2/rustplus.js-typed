"use strict";

import { EventEmitter } from "events";
import { Promisable, RequireAtLeastOne, SetRequired } from "type-fest";
import WebSocket from "ws";
import TypedEmitter from "typed-emitter";

import Camera from "./camera";
import * as Proto from "./proto";

declare module "./proto" {
  interface AppEmpty extends Record<string, never> {}
}

type Response<T> = { seq: Proto.AppResponse["seq"] } & (
  | ({ error: undefined | null } & SetRequired<T, keyof T>)
  | { error: Proto.AppError }
);

// Seq, playerId, and playerToken are never needed because they are assigned in sendRequest
type sendRequestData = RequireAtLeastOne<
  Omit<Proto.AppRequest, "seq" | "playerId" | "playerToken">
>;

/* 
    T is an array of keys of sendRequestData e.g. ["getTime"] works because getTime is a key of AppRequest

    U is an array of keys of Proto.AppResponse e.g. ["time"] works because time is a key of AppResponse

    T, U must not be empty arrays

    Required<Pick<sendRequestData, T[number]>>:
    - Pick<sendRequestData, T[number]> gets the types from the keys in T (e.g. 'getTime' => getTime: AppEmpty)
    - Required<Pick<sendRequestData, T[number]>> makes all the keys in T required (e.g. getTime | undefined becomes getTime)

    Pick<Proto.AppResponse, U[number]>:
    - Pick<Proto.AppResponse, U[number]> gets the types from the keys in U (e.g. 'time' => time: AppTime)
    - Response<Pick<Proto.AppResponse, U[number]>> The server either returns with success: boolean and error: AppError | undefined, error seems to be tied to success false, so we represent this as a union. We also remove the undefined property from the data returned at this stage. 

*/
type sendReqType<
  T extends (keyof sendRequestData)[],
  U extends (keyof Proto.AppResponse)[]
> = {
  data: Required<Pick<sendRequestData, T[number]>>;
  response: Response<Pick<Proto.AppResponse, U[number]>>;
  callback: _callbackFn<Response<Pick<Proto.AppResponse, U[number]>>>;
};

interface allRequests {
  cameraInput: sendReqType<["cameraInput"], ["success"]>; // todo manually verify, currently based on server source code
  cameraSubscribe: sendReqType<["cameraSubscribe"], ["cameraSubscribeInfo"]>;
  cameraUnsubscribe: sendReqType<["cameraUnsubscribe"], ["success"]>;
  checkSubscription: sendReqType<
    ["checkSubscription"],
    ["cameraSubscribeInfo"]
  >;
  getClanChat: sendReqType<["getClanChat"], ["clanChat"]>;
  getClanInfo: sendReqType<["getClanInfo"], ["clanInfo"]>;
  getEntityInfo: sendReqType<["getEntityInfo", "entityId"], ["entityInfo"]>;
  getNexusAuth: sendReqType<["getNexusAuth"], ["nexusAuth"]>; // todo manually verify
  getInfo: sendReqType<["getInfo"], ["info"]>;
  getMap: sendReqType<["getMap"], ["map"]>;
  getMapMarkers: sendReqType<["getMapMarkers"], ["mapMarkers"]>;
  getTeamChat: sendReqType<["getTeamChat"], ["teamChat"]>;
  getTeamInfo: sendReqType<["getTeamInfo"], ["teamInfo"]>;
  getTime: sendReqType<["getTime"], ["time"]>;
  promoteToLeader: sendReqType<["promoteToLeader"], ["success"]>;
  sendClanMessage: sendReqType<["sendClanMessage"], ["success"]>;
  sendTeamMessage: sendReqType<["sendTeamMessage"], ["success"]>;
  setClanMotd: sendReqType<["setClanMotd"], ["success"]>;
  setEntityValue: sendReqType<["setEntityValue", "entityId"], ["success"]>;
  setSubscription: sendReqType<["setSubscription", "entityId"], ["success"]>; // todo manually verify
}

type sendRequestReturnType = Promisable<void> | boolean; // If returns true then don't fire message event

type _callbackFn<T = allRequests[keyof allRequests]["response"]> = (message: {
  response: T;
}) => sendRequestReturnType;
type unhandled = {
  seq: number;
  error: { error: "unhandled" };
};
type unhandledReturn = _callbackFn<unhandled>;
type callbackFn = _callbackFn;

type RustPlusEvents = {
  error: (error: Error) => Promisable<void>;
  connected: () => Promisable<void>;
  connecting: () => Promisable<void>;
  disconnected: () => Promisable<void>;
  message: (message: Proto.AppMessage) => Promisable<void>;
  request: (request: Proto.AppRequest) => Promisable<void>;
};

export class RustPlus extends (EventEmitter as new () => TypedEmitter<RustPlusEvents>) {
  private seq: number;
  private seqCallbacks: callbackFn[];

  public readonly server: string;
  public readonly port: string;
  public readonly playerId: string;
  public readonly playerToken: string;
  private readonly _playerId: Proto.AppRequest["playerId"];
  private readonly _playerToken: Proto.AppRequest["playerToken"];
  public readonly useFacepunchProxy: boolean;

  /* Defined on first connection, null on disconnect */
  protected websocket: WebSocket | null | undefined;
  /* Defined on first connection */
  private AppRequest: typeof Proto.AppRequest | undefined;
  /* Defined on first connection */
  private AppMessage: typeof Proto.AppMessage | undefined;

  /**
   * @param server The ip address or hostname of the Rust Server
   * @param port The port of the Rust Server (app.port in server.cfg)
   * @param playerId SteamId of the Player
   * @param playerToken Player Token from Server Pairing
   * @param useFacepunchProxy True to use secure websocket via Facepunch's proxy, or false to directly connect to Rust Server
   *
   * Events emitted by the RustPlus class instance
   * - connecting: When we are connecting to the Rust Server.
   * - connected: When we are connected to the Rust Server.
   * - message: When an AppMessage has been received from the Rust Server.
   * - request: When an AppRequest has been sent to the Rust Server.
   * - disconnected: When we are disconnected from the Rust Server.
   * - error: When something goes wrong.
   */
  constructor(
    server: string,
    port: string,
    playerId: string,
    playerToken: string,
    useFacepunchProxy: boolean = false
  ) {
    super();

    this.server = server;
    this.port = port;
    this.playerId = playerId;
    this.playerToken = playerToken;
    this._playerId = String(playerId);
    this._playerToken = Number(playerToken);
    this.useFacepunchProxy = useFacepunchProxy;

    this.seq = 0;
    this.seqCallbacks = [];
  }

  /**
   * This sets everything up and then connects to the Rust Server via WebSocket.
   */
  connect() {
    // load protobuf then connect

    // make sure existing connection is disconnected before connecting again.
    if (this.websocket) {
      this.disconnect();
    }

    // load proto types
    this.AppRequest = Proto.AppRequest;
    this.AppMessage = Proto.AppMessage;

    // fire event as we are connecting
    this.emit("connecting");

    // connect to websocket
    var address = this.useFacepunchProxy
      ? `wss://companion-rust.facepunch.com/game/${this.server}/${this.port}`
      : `ws://${this.server}:${this.port}`;
    this.websocket = new WebSocket(address);

    // fire event when connected
    this.websocket.on("open", () => {
      this.emit("connected");
    });

    // fire event for websocket errors
    this.websocket.on("error", (e: any) => {
      this.emit("error", e);
    });

    this.websocket.on("message", (data: Uint8Array) => {
      if (!this.AppMessage) return;

      // decode received message
      var message = this.AppMessage.fromBinary(data) as unknown as {
        response: allRequests[keyof allRequests]["response"];
      }; //! remove if better method

      // check if received message is a response and if we have a callback registered for it
      if (
        message.response &&
        message.response.seq &&
        this.seqCallbacks[message.response.seq]
      ) {
        // get the callback for the response sequence
        var callback = this.seqCallbacks[message.response.seq];

        // call the callback with the response message
        var result = callback(message);

        // remove the callback
        delete this.seqCallbacks[message.response.seq];

        // ! If callback is a promise, this will run anyways
        // if callback returns true, don't fire message event
        if (result) {
          return;
        }
      }

      // fire message event for received messages that aren't handled by callback
      this.emit("message", this.AppMessage.fromBinary(data));
    });

    // fire event when disconnected
    this.websocket.on("close", () => {
      this.emit("disconnected");
    });
  }

  /**
   * Disconnect from the Rust Server.
   */
  disconnect() {
    if (this.websocket) {
      this.websocket.terminate();
      this.websocket = null;
    }
  }

  /**
   * Check if RustPlus is connected to the server.
   * @returns {boolean}
   */
  isConnected(): boolean {
    // Note: null == undefined. Keep != over !==
    return (
      this.websocket != null && this.websocket.readyState === WebSocket.OPEN
    );
  }

  /*
   DO NOT randomly change order of callback chain!
   It's based off processing order of if statement inside Assembly-Csharp.dll (Server files) path = "CompanionServer ns > Listener class > Dispatch method"
   
   Rust+ checks each statement one by one in a short circuiting if statement. The first one to return true (can be handled) gets executed

   Some issues encountered with other solutions:
   - "any" type, or un-narrowed union in type for server response (all possible values unioned)
   - Unrelated TS errors when passed bad data - makes it harder for user (at least w/ overload solution)
   
   If you can get a better solution that uses less code but provides >= type accuracy, please replace this
   */
  /**
   * Send a Request to the Rust Server with an optional callback when a Response is received.
   * @param data this should contain valid data for the AppRequest packet in the rustplus.proto schema file
   * @param callback
   */
  sendRequest<T extends keyof allRequests, D extends allRequests[T]["data"]>(
    data: D,
    callback?: "getInfo" extends keyof D
      ? allRequests["getInfo"]["callback"]
      : "getTime" extends keyof D
      ? allRequests["getTime"]["callback"]
      : "getMap" extends keyof D
      ? allRequests["getMap"]["callback"]
      : "getTeamInfo" extends keyof D
      ? allRequests["getTeamInfo"]["callback"]
      : "getTeamChat" extends keyof D
      ? allRequests["getTeamChat"]["callback"]
      : "sendTeamMessage" extends keyof D
      ? allRequests["sendTeamMessage"]["callback"]
      : "getEntityInfo" extends keyof D
      ? allRequests["getEntityInfo"]["callback"]
      : "setEntityValue" extends keyof D
      ? allRequests["setEntityValue"]["callback"]
      : "checkSubscription" extends keyof D
      ? allRequests["checkSubscription"]["callback"]
      : "setSubscription" extends keyof D
      ? allRequests["setSubscription"]["callback"]
      : "getMapMarkers" extends keyof D
      ? allRequests["getMapMarkers"]["callback"]
      : "promoteToLeader" extends keyof D
      ? allRequests["promoteToLeader"]["callback"]
      : "getClanInfo" extends keyof D
      ? allRequests["getClanInfo"]["callback"]
      : "getClanChat" extends keyof D
      ? allRequests["getClanChat"]["callback"]
      : "setClanMotd" extends keyof D
      ? allRequests["setClanMotd"]["callback"]
      : "sendClanMessage" extends keyof D
      ? allRequests["sendClanMessage"]["callback"]
      : "getNexusAuth" extends keyof D
      ? allRequests["getNexusAuth"]["callback"]
      : "cameraSubscribe" extends keyof D
      ? allRequests["cameraSubscribe"]["callback"]
      : "cameraUnsubscribe" extends keyof D
      ? allRequests["cameraUnsubscribe"]["callback"]
      : "cameraInput" extends keyof D
      ? allRequests["cameraInput"]["callback"]
      : unhandledReturn
  ): sendRequestReturnType;

  sendRequest<T extends keyof allRequests>(
    data: allRequests[T]["data"],
    callback?: (message: {
      response: allRequests[T]["response"];
    }) => sendRequestReturnType
  ) {
    if (!this.AppRequest || !this.websocket) return;

    // increment sequence number
    let currentSeq = ++this.seq;

    // save callback if provided
    if (callback) {
      this.seqCallbacks[currentSeq] = callback;
    }

    // create protobuf from AppRequest packet
    let request = this.AppRequest.toBinary({
      seq: currentSeq,
      playerId: this._playerId,
      playerToken: this._playerToken,
      ...data, // merge in provided data for AppRequest
    });

    // send AppRequest packet to rust server
    this.websocket.send(request);

    // fire event when request has been sent, this is useful for logging
    this.emit("request", this.AppRequest.fromBinary(request));
  }

  /**
   * Send a Request to the Rust Server and return a Promise
   * @param data this should contain valid data for the AppRequest packet defined in the rustplus.proto schema file
   * @param timeoutMilliseconds milliseconds before the promise will be rejected. Defaults to 10 seconds.
   */
  sendRequestAsync<
    T extends keyof allRequests,
    D extends allRequests[T]["data"]
  >(
    data: D,
    timeoutMilliseconds?: number
  ): Promise<
    "getInfo" extends keyof D
      ? allRequests["getInfo"]["response"]
      : "getTime" extends keyof D
      ? allRequests["getTime"]["response"]
      : "getMap" extends keyof D
      ? allRequests["getMap"]["response"]
      : "getTeamInfo" extends keyof D
      ? allRequests["getTeamInfo"]["response"]
      : "getTeamChat" extends keyof D
      ? allRequests["getTeamChat"]["response"]
      : "sendTeamMessage" extends keyof D
      ? allRequests["sendTeamMessage"]["response"]
      : "getEntityInfo" extends keyof D
      ? allRequests["getEntityInfo"]["response"]
      : "setEntityValue" extends keyof D
      ? allRequests["setEntityValue"]["response"]
      : "checkSubscription" extends keyof D
      ? allRequests["checkSubscription"]["response"]
      : "setSubscription" extends keyof D
      ? allRequests["setSubscription"]["response"]
      : "getMapMarkers" extends keyof D
      ? allRequests["getMapMarkers"]["response"]
      : "promoteToLeader" extends keyof D
      ? allRequests["promoteToLeader"]["response"]
      : "getClanInfo" extends keyof D
      ? allRequests["getClanInfo"]["response"]
      : "getClanChat" extends keyof D
      ? allRequests["getClanChat"]["response"]
      : "setClanMotd" extends keyof D
      ? allRequests["setClanMotd"]["response"]
      : "sendClanMessage" extends keyof D
      ? allRequests["sendClanMessage"]["response"]
      : "getNexusAuth" extends keyof D
      ? allRequests["getNexusAuth"]["response"]
      : "cameraSubscribe" extends keyof D
      ? allRequests["cameraSubscribe"]["response"]
      : "cameraUnsubscribe" extends keyof D
      ? allRequests["cameraUnsubscribe"]["response"]
      : "cameraInput" extends keyof D
      ? allRequests["cameraInput"]["response"]
      : unhandled
  >;

  sendRequestAsync<T extends keyof allRequests>(
    data: allRequests[T]["data"],
    timeoutMilliseconds: number = 10000
  ): Promise<Parameters<allRequests[T]["callback"]>[0]["response"]> {
    return new Promise((resolve, reject) => {
      // reject promise after timeout
      var timeout = setTimeout(() => {
        reject(new Error("Timeout reached while waiting for response"));
      }, timeoutMilliseconds);
      // send request
      this.sendRequest(
        data as Parameters<typeof this.sendRequest>[0],
        // May cause error here if unhandled response changed to never type
        (message) => {
          // cancel timeout
          clearTimeout(timeout);

          if (message.response.error) {
            // reject promise if server returns an AppError for this request
            reject(message.response.error);
          } else {
            // request was successful, resolve with message.response
            resolve(message.response);
          }
        }
      );
    });
  }

  /**
   * Send a Request to the Rust Server to set the Entity Value.
   * @param entityId the entity id to set the value for
   * @param value the value to set on the entity
   * @param callback
   */
  setEntityValue(
    entityId: number,
    value: boolean,
    callback?: allRequests["setEntityValue"]["callback"]
  ) {
    this.sendRequest(
      {
        entityId: entityId,
        setEntityValue: {
          value: value,
        },
      },
      callback
    );
  }

  /**
   * Turn a Smart Switch On
   * @param entityId the entity id of the smart switch to turn on
   * @param callback
   */
  turnSmartSwitchOn(
    entityId: number,
    callback?: allRequests["setEntityValue"]["callback"]
  ) {
    this.setEntityValue(entityId, true, callback);
  }

  /**
   * Turn a Smart Switch Off
   * @param entityId the entity id of the smart switch to turn off
   * @param callback
   */
  turnSmartSwitchOff(
    entityId: number,
    callback?: allRequests["setEntityValue"]["callback"]
  ) {
    this.setEntityValue(entityId, false, callback);
  }

  /**
   * Quickly turn on and off a Smart Switch as if it were a Strobe Light.
   * You will get rate limited by the Rust Server after a short period.
   * It was interesting to watch in game though 😝
   */
  strobe(entityId: number, timeoutMilliseconds = 100, value = true) {
    this.setEntityValue(entityId, value);
    setTimeout(() => {
      this.strobe(entityId, timeoutMilliseconds, !value);
    }, timeoutMilliseconds);
  }

  /**
   * Send a message to Team Chat
   * @param message the message to send to team chat
   * @param callback
   */
  sendTeamMessage(
    message: string,
    callback?: allRequests["sendTeamMessage"]["callback"]
  ) {
    this.sendRequest(
      {
        sendTeamMessage: {
          message: message,
        },
      },
      callback
    );
  }

  /**
   * Get info for an Entity
   * @param entityId the id of the entity to get info of
   * @param callback
   */
  getEntityInfo(
    entityId: any,
    callback?: allRequests["getEntityInfo"]["callback"]
  ) {
    this.sendRequest(
      {
        entityId: entityId,
        getEntityInfo: {},
      },
      callback
    );
  }

  /**
   * Get the Map
   */
  getMap(callback?: allRequests["getMap"]["callback"]) {
    this.sendRequest(
      {
        getMap: {},
      },
      callback
    );
  }

  /**
   * Get the in-game time
   */
  getTime(callback?: allRequests["getTime"]["callback"]) {
    this.sendRequest(
      {
        getTime: {},
      },
      callback
    );
  }

  /**
   * Get all map markers
   */
  getMapMarkers(callback?: allRequests["getMapMarkers"]["callback"]) {
    this.sendRequest(
      {
        getMapMarkers: {},
      },
      callback
    );
  }

  /**
   * Get the server info
   */
  getInfo(callback: allRequests["getInfo"]["callback"]) {
    this.sendRequest(
      {
        getInfo: {},
      },
      callback
    );
  }

  /**
   * Get team info
   */
  getTeamInfo(callback?: allRequests["getTeamInfo"]["callback"]) {
    this.sendRequest(
      {
        getTeamInfo: {},
      },
      callback
    );
  }

  /**
   * Subscribes to a Camera
   * @param identifier Camera Identifier, such as OILRIG1 (or custom name)
   * @param callback
   */
  subscribeToCamera(
    identifier: string,
    callback?: allRequests["cameraSubscribe"]["callback"]
  ) {
    this.sendRequest(
      {
        cameraSubscribe: {
          cameraId: identifier,
        },
      },
      callback
    );
  }

  /**
   * Unsubscribes from a Camera
   * @param callback
   */
  unsubscribeFromCamera(
    callback?: allRequests["cameraUnsubscribe"]["callback"]
  ) {
    this.sendRequest(
      {
        cameraUnsubscribe: {},
      },
      callback
    );
  }

  /**
   * Sends camera input to the server (mouse movement)
   * @param buttons The buttons that are currently pressed
   * @param x The x delta of the mouse movement
   * @param y The y delta of the mouse movement
   * @param callback
   */
  sendCameraInput(
    buttons: number,
    x: number,
    y: number,
    callback?: allRequests["cameraInput"]["callback"]
  ) {
    this.sendRequest(
      {
        cameraInput: {
          buttons: buttons,
          mouseDelta: {
            x: x,
            y: y,
          },
        },
      },
      callback
    );
  }

  /**
   * Get a camera instance for controlling CCTV Cameras, PTZ Cameras and  Auto Turrets
   * @param identifier Camera Identifier, such as DOME1, OILRIG1L1, (or a custom camera id)
   * @returns {Camera}
   */
  getCamera(identifier: string) {
    return new Camera(this, identifier);
  }
}
