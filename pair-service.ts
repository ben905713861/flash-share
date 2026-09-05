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

    pair(pairKey: string, ws: WebSocket): WebSocket {
        const pair: Pair | undefined = this.#wsPendingMap.get(pairKey);
        if (!pair) {
            throw new Error('pairKey is not registered.');
        }
        if (pair.ws === ws) {
            throw new Error('unable to pair with same ws.');
        }
        this.#wsPendingMap.delete(pairKey);
        this.#wsPendingMap2.delete(pair.ws);
        if (pair.ws.readyState !== WebSocket.OPEN) {
            throw new Error('target ws is not opened.');
        }
        // clear requester
        const requesterPair: Pair | undefined = this.#wsPendingMap2.get(ws);
        if (requesterPair) {
            this.#wsPendingMap.delete(requesterPair.pairKey);
            this.#wsPendingMap2.delete(requesterPair.ws);
        }
        return pair.ws;
    }

    unregister(ws: WebSocket) {
        const pair: Pair | undefined = this.#wsPendingMap2.get(ws);
        if (pair) {
            this.#wsPendingMap2.delete(ws);
            this.#wsPendingMap.delete(pair.pairKey);
        }
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
    createTime: Date;
}
