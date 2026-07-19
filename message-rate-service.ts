import {WebSocket} from 'ws';

const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const MAX_MESSAGES_PER_WINDOW = 60;

export default class MessageRateService {
    #messageRates: WeakMap<WebSocket, MessageRate> = new WeakMap();

    isRateLimited(ws: WebSocket): boolean {
        const now = Date.now();
        const rate = this.#messageRates.get(ws);
        if (!rate || now - rate.startedAt >= RATE_LIMIT_WINDOW_MS) {
            const messageRate: MessageRate = { startedAt: now, count: 1 };
            this.#messageRates.set(ws, messageRate);
            return false;
        }
        rate.count += 1;
        return rate.count > MAX_MESSAGES_PER_WINDOW;
    }

}

type MessageRate = {
    startedAt: number;
    count: number;
};

