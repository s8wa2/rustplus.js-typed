"use strict";

const path = require('path');
const WebSocket = require('ws');
const protobuf = require("protobufjs");
const { EventEmitter } = require('events');

class RustPlus extends EventEmitter {

    /**
     * @param server The ip address or hostname of the Rust Server
     * @param port The port of the Rust Server (app.port in server.cfg)
     * @param playerId SteamId of the Player
     * @param playerToken Player Token from Server Pairing
     * @param useFacepunchProxy True to use secure websocket via Facepunch's proxy, or false to directly connect to Rust Server
     */
    constructor(server, port, playerId, playerToken, useFacepunchProxy = false) {

        super();

        this.server = server;
        this.port = port;
        this.playerId = playerId;
        this.playerToken = playerToken;
        this.useFacepunchProxy = useFacepunchProxy;

        this.seq = 0;
        this.seqCallbacks = [];

        this.connect();

    }

    /**
     * This sets everything up and then connects to the Rust Server via WebSocket.
     * Events Emitted:
     * - connecting: When we are connecting to the Rust Server.
     * - connected: When we are connected to the Rust Server.
     * - message: When a AppMessage has been received from the Rust Server.
     * - disconnected: When we are disconnected from the Rust Server.
     */
    connect() {

        // load protobuf then connect
        protobuf.load(path.resolve(__dirname, "rustplus.proto")).then((root) => {

            // load proto types
            this.AppRequest = root.lookupType("rustplus.AppRequest");
            this.AppMessage = root.lookupType("rustplus.AppMessage");

            // fire event as we are connecting
            this.emit('connecting');

            // connect to websocket
            var address = this.useFacepunchProxy ? `wss://companion-rust.facepunch.com/game/${this.server}/${this.port}` : `ws://${this.server}:${this.port}`;
            this.websocket = new WebSocket(address);

            // fire event when connected
            this.websocket.on('open', () => {
                this.emit('connected');
            });

            // fire event for websocket errors
            this.websocket.on('error', (e) => {
                this.emit('error', e);
            });

            this.websocket.on('message', (data) => {

                // decode received message
                var message = this.AppMessage.decode(data);

                // check if received message is a response and if we have a callback registered for it
                if(message.response && message.response.seq && this.seqCallbacks[message.response.seq]){

                    // get the callback for the response sequence
                    var callback = this.seqCallbacks[message.response.seq];

                    // call the callback with the response message
                    var result = callback(message);

                    // remove the callback
                    delete this.seqCallbacks[message.response.seq];

                    // if callback returns true, don't fire message event
                    if(result){
                        return;
                    }

                }

                // fire message event for received messages that aren't handled by callback
                this.emit('message', this.AppMessage.decode(data));

            });

            // fire event when disconnected
            this.websocket.on('close', () => {
                this.emit('disconnected');
            });

        });

    }

    /**
     * Send a Request to the Rust Server with an optional callback when a Response is received.
     */
    sendRequest(data, callback) {

        // increment sequence number
        let currentSeq = ++this.seq;

        // save callback if provided
        if(callback){
            this.seqCallbacks[currentSeq] = callback;
        }

        // create base payload
        let payload = {
            seq: currentSeq,
            playerId: this.playerId,
            playerToken: this.playerToken,
        };

        // merge in request data
        payload = {...payload, ...data};

        // create app request protobuf
        let message = this.AppRequest.fromObject(payload);

        // send app request to rust server
        this.websocket.send(this.AppRequest.encode(message).finish());

        // fire event when request has been sent, this is useful for logging
        this.emit('request', message);

    }

    /**
     * Send a Request to the Rust Server to set the Entity Value.
     */
    setEntityValue(entityId, value, callback) {
        this.sendRequest({
            entityId: entityId,
            setEntityValue: {
                value: value,
            },
        }, callback);
    }

    /**
     * Turn a Smart Switch On
     */
    turnSmartSwitchOn(entityId, callback) {
        this.setEntityValue(entityId, true, callback);
    }

    /**
     * Turn a Smart Switch Off
     */
    turnSmartSwitchOff(entityId, callback) {
        this.setEntityValue(entityId, false, callback);
    }

    /**
     * Quickly turn on and off a Smart Switch as if it were a Strobe Light.
     * You will get rate limited by the Rust Server after a short period.
     * It was interesting to watch in game though 😝
     */
    strobe(entityId, timeoutMilliseconds = 100, value = true) {
        this.setEntityValue(entityId, value);
        setTimeout(() => {
            this.strobe(entityId, timeoutMilliseconds, !value);
        }, timeoutMilliseconds);
    }

    /**
     * Send a message to Team Chat
     */
    sendTeamMessage(message, callback) {
        this.sendRequest({
            sendTeamMessage: {
                message: message,
            },
        }, callback);
    }

    /**
     * Get info for an Entity
     */
    getEntityInfo(entityId, callback) {
        this.sendRequest({
            entityId: entityId,
            getEntityInfo: {

            },
        }, callback);
    }

    /**
     * Get the Map
     */
    getMap(callback) {
        this.sendRequest({
            getMap: {

            },
        }, callback);
    }
    
    /**
     * Get the ingame time
    */
    getTime(callback) {
        this.sendRequest({
            getTime: {

            },
        }, callback);
    }

    /**
     * Get all map markers
     */
    getMapMarkers(callback) {
        this.sendRequest({
            getMapMarkers: {

            },
        }, callback);
    }
    
    /**
     * Get the server info
     */
    getInfo(callback) {
        this.sendRequest({
            getInfo: {

            },
        }, callback);
    }

}

module.exports = RustPlus;
