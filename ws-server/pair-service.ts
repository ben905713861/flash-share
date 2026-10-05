import {WebSocket} from 'ws';

export class PairService {

    #wsPendingMap: Map<string, Pair> = new Map();
    #wsPendingMap2: Map<WebSocket, Pair> = new Map();

    constructor() {
        setInterval(() => this.#clear(), 60 * 1000);
    }

    register(pairKey: string, ws: WebSocket) {
        let pair: Pair | undefined = this.#wsPendingMap.get(pairKey);
        if (pair) {
            console.warn("pairKey is already in used, pairKey=", pairKey);
            return false;
        }
        pair = { pairKey, ws, createTime: new Date() }
        this.#wsPendingMap.set(pairKey, pair);
        this.#wsPendingMap2.set(ws, pair);
        return true;
    }

    prePair(pairKey: string, ws: WebSocket): WebSocket {
        const pair: Pair | undefined = this.#wsPendingMap.get(pairKey);
        if (!pair) {
            throw new Error('pairKey is not registered.');
        }
        if (pair.ws === ws) {
            throw new Error('unable to pair with same ws.');
        }
        const requesterPair = this.#wsPendingMap2.get(ws);
        if (requesterPair?.prePairWs) {
            throw new Error('device already has a pending pair request');
        }
        for (const pendingPair of this.#wsPendingMap.values()) {
            if (pendingPair.prePairWs === ws) {
                throw new Error('device already has a pending pair request');
            }
        }
        if (pair.prePairWs) {
            throw new Error('another device has sent pair request');
        }
        if (pair.ws.readyState !== WebSocket.OPEN) {
            throw new Error('target ws is not opened.');
        }
        pair.prePairWs = ws;
        return pair.ws;
    }

    pair(ws: WebSocket): WebSocket {
        const pair: Pair | undefined = this.#wsPendingMap2.get(ws);
        if (!pair) {
            throw new Error('pairKey is not registered.');
        }
        if (!pair.prePairWs) {
            throw new Error('did not receive prePair request');
        }
        if (pair.prePairWs.readyState !== WebSocket.OPEN) {
            pair.prePairWs = undefined;
            throw new Error('target ws is not opened.');
        }
        this.#wsPendingMap.delete(pair.pairKey);
        this.#wsPendingMap2.delete(pair.ws);
        // clear requester
        const requesterPair: Pair | undefined = this.#wsPendingMap2.get(pair.prePairWs);
        if (requesterPair) {
            this.#wsPendingMap.delete(requesterPair.pairKey);
            this.#wsPendingMap2.delete(requesterPair.ws);
        }
        return pair.prePairWs;
    }

    unregister(ws: WebSocket) {
        const pair: Pair | undefined = this.#wsPendingMap2.get(ws);
        if (pair) {
            this.#wsPendingMap2.delete(ws);
            this.#wsPendingMap.delete(pair.pairKey);
        }
        this.#wsPendingMap.forEach((pendingPair) => {
            if (pendingPair.prePairWs === ws) {
                pendingPair.prePairWs = undefined;
            }
        });
    }

    #clear() {
        this.#wsPendingMap.forEach((pair: Pair, pairKey: string) => {
            if (Date.now() - pair.createTime.getTime() > 180 * 1000) {
                this.#wsPendingMap2.delete(pair.ws);
                this.#wsPendingMap.delete(pairKey);
            }
        });
    }
}

type Pair = {
    pairKey: string;
    ws: WebSocket;
    prePairWs?: WebSocket;
    createTime: Date;
}
