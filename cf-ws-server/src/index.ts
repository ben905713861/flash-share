import { DurableObject } from "cloudflare:workers";
import {randomUUID} from "crypto";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES = 60;

type Message = { type?: string; data?: Record<string, unknown>; roomKey?: string };

const textOf = (message: string | ArrayBuffer) => {
	return typeof message === "string" ? message : new TextDecoder().decode(message);
}


function sendMsg(ws: WebSocket, type: string, data?: unknown) {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type, data }));
	}
}

function parse(message: string | ArrayBuffer): Message | null {
	const text = textOf(message);
	if (text.length > MAX_PAYLOAD_BYTES) {
		return null;
	}
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value as Message : null;
	} catch {
		return null;
	}
}

function http(status: number, body: string) {
	return new Response(body, { status });
}

/** One independently-addressable DO per pairKey. */
export class PairingRoom extends DurableObject<Env> {
	private readonly state: DurableObjectState;
	private readonly environment: Env;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env); this.state = state;
		this.environment = env;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return http(426, "Expected WebSocket");
		}
		return this.state.blockConcurrencyWhile(async () => {
			const isPaired = await this.state.storage.get<boolean>("isPaired");
			if (isPaired) {
				return http(409, "pairKey is already paired");
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			const anotherWs = this.state.getWebSockets()
				.find(it => it.readyState === WebSocket.OPEN);
			if (anotherWs) {
				// DO contains another ws, return error and exit
				return http(409, "pairKey is already registered");
			}
			this.state.acceptWebSocket(server);

			const pairKey = new URL(request.url).searchParams.get("pairKey")!;
			await this.state.storage.put("pairKey", pairKey);

			sendMsg(server, "PENDING_PAIR_SUCC", { pairKey });
			const targetPairKey = new URL(request.url).searchParams.get("targetPairKey");
			if (targetPairKey) {
				await this.pair(server, targetPairKey);
			}
			return new Response(null, { status: 101, webSocket: client });
		});
	}

	async checkPairKeyExist(): Promise<boolean> {
		const wsList = this.state.getWebSockets()
			.filter(it => it.readyState === WebSocket.OPEN);
		return wsList.length > 0;
	}

	async getPairKey(): Promise<string> {
		const pairKey = await this.state.storage.get<string>("pairKey");
		if (!pairKey) {
			throw new Error("pairKey didn't bind to DO");
		}
		return pairKey;
	}

	async notifyPrePaired(requesterPairKey: string, passcode: string): Promise<string | null> {
		return this.state.blockConcurrencyWhile(async () => {
			const isPaired = await this.state.storage.get<boolean>("isPaired") ?? false;
			if (isPaired) {
				return "pairKey is not registered";
			}
			const storageRequesterPairKey = await this.state.storage.get<string>("requesterPairKey");
			if (storageRequesterPairKey) {
				return "another device has sent pair request";
			}
			const ws: WebSocket[] = this.state.getWebSockets();
			if (ws.length === 0) {
				return "pairKey is not registered";
			}
			const thisWs = ws.find(it => it.readyState === WebSocket.OPEN);
			if (!thisWs) {
				return "target ws is not opened.";
			}
			await this.state.storage.put("requesterPairKey", requesterPairKey);
			sendMsg(thisWs, "WAITING_PAIR_CONFIRM", { passcode });
			return null;
		});
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		let reqBody;
		try {
			reqBody = JSON.parse(textOf(message));
		} catch (e) {
			if (e instanceof Error) {
				console.error('invalid request body', textOf(message), e);
				sendMsg(ws, 'ERROR', { error: 'invalid request body' });
			}
			return;
		}
		if (reqBody == null || reqBody instanceof Array) {
			sendMsg(ws, "ERROR", { error: "invalid request body" });
			return;
		}
		const { type, data } = reqBody;
		if (!type) {
			sendMsg(ws, "ERROR", { error: "Unsupported message on pair connection" });
			return;
		}
		if (!data) {
			sendMsg(ws, "ERROR", { error: "data cannot be null" });
			return;
		}
		console.log("received type:", type);
		if (type === 'PAIR_CONFIRM') {
			const pending = await this.state.storage.get<{roomKey:string; requesterPairKey:string}>("pending");
			if (!pending) { sendMsg(ws, "ERROR", {error:"no pending pair confirmation"}); return; }
			const requester = this.environment.PAIRING.getByName(pending.requesterPairKey);
			const notified = await requester.notifyConfirmed(pending.roomKey);
			if (!notified) {
				sendMsg(ws, "PAIR_FAIL", { error: "requesting device is no longer connected" });
				await this.state.storage.delete("pending");
				return;
			}
			await this.state.storage.put("isPaired", true);
			await this.state.storage.delete("pending");
			return;
		}
		if (type === 'PAIR_REJECT') {
			const pending = await this.state.storage.get<{roomKey:string; requesterPairKey:string}>("pending");
			if (!pending) { sendMsg(ws, "ERROR", {error:"no pending pair confirmation"}); return; }
			const requester = this.environment.PAIRING.getByName(pending.requesterPairKey);
			await requester.notifyRejected();
			await this.state.storage.delete("pending");
		}
	}

	async pair(ws: WebSocket, targetPairKey?: string, passcode = String(Math.floor(100000 + Math.random() * 900000))) {
		if (!targetPairKey) {
			sendMsg(ws, 'PAIR_FAIL', { error: 'targetPairKey is missing' });
			return;
		}
		if (!passcode) {
			sendMsg(ws, 'PAIR_FAIL', {error:'passcode is missing'});
			return;
		}
		const thisDOPairKey = await this.getPairKey();
		if (thisDOPairKey === targetPairKey) {
			sendMsg(ws, 'PAIR_FAIL', { error: "unable to pair with same ws。" });
			return;
		}
		// prePair
		try {
			const targetStub = this.environment.PAIRING.getByName(targetPairKey);
			const prePareResult = await targetStub.notifyPrePaired(thisDOPairKey, passcode);
			if (prePareResult) {
				sendMsg(ws, 'PAIR_FAIL', { error: prePareResult });
				return;
			}
			sendMsg(ws, 'PAIR_STARTED', { passcode });
			// requester is notified after confirmation
		} catch (e) {
			if (e instanceof Error) {
				console.error('register pairKey failed', e);
				sendMsg(ws, 'PAIR_FAIL', { error: e.message });
			}
		}
	}

	async notifyConfirmed(roomKey: string): Promise<boolean> {
		const ws = this.state.getWebSockets()
			.find(it => it.readyState === WebSocket.OPEN);
		if (!ws) return false;
		sendMsg(ws, "PAIR_SUCC", {roomKey});
		return true;
	}

	async notifyRejected() {
		const ws = this.state.getWebSockets()
			.find(it => it.readyState === WebSocket.OPEN);
		if (ws) {
			sendMsg(ws, "PAIR_REJECT");
		}
	}

	async webSocketClose(ws: WebSocket) {
		await this.state.storage.delete("isPaired");
		await this.state.storage.delete("pending");
	}

}

/** One independently-addressable DO per roomKey, limited to two peers. */
export class ChatRoom extends DurableObject<Env> {
	private readonly state: DurableObjectState;
	constructor(state: DurableObjectState, env: Env) { super(state, env); this.state = state; }
	private readonly rates = new WeakMap<WebSocket, { startedAt: number; count: number }>();

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return http(426, "Expected WebSocket");
		}
		const existing = this.state.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN);
		if (existing.length >= 2) {
			return http(1013, "room is full");
		}
		const pair = new WebSocketPair();
		this.state.acceptWebSocket(pair[1]);
		const sockets = [...existing, pair[1]];
		this.joinRoom(pair[1], sockets);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const now = Date.now(); const rate = this.rates.get(ws);
		if (!rate || now - rate.startedAt >= RATE_WINDOW_MS) {
			this.rates.set(ws, { startedAt: now, count: 1 });
		} else if (++rate.count > MAX_MESSAGES) {
			ws.close(1008, "Too many messages");
			return;
		}
		const text = textOf(message);
		if (text.length > MAX_PAYLOAD_BYTES) {
			ws.close(1009, "Message too big");
			return;
		}
		this.handleMessage(ws, text); return;
	}

	private handleMessage(ws: WebSocket, message: string | ArrayBuffer) {
		const body = parse(message);
		if (!body?.type) {
			sendMsg(ws, "ERROR", { error: "invalid request body" });
			return;
		}
		if (body.type === "JOIN_ROOM") {
			return;
		}
		for (const peer of this.state.getWebSockets()) {
			if (peer !== ws && peer.readyState === WebSocket.OPEN) {
				peer.send(textOf(message));
			}
		}
	}
	private joinRoom(ws: WebSocket, sockets: WebSocket[]) {
		if (sockets.length === 1) {
			sendMsg(ws, "JOIN_ROOM_WAIT");
		} else {
			sockets.forEach((item, index) => {
				sendMsg(item, "JOIN_ROOM_SUCC", {isOfferer: index === 0})
			});
		}
	}
}

async function pendingPair(request: Request, env: Env) {
	let pairKey: string;
	while (true) {
		pairKey = randomUUID();
		const pairService = env.PAIRING.getByName(pairKey);
		const registerResult = await pairService.checkPairKeyExist();
		if (!registerResult) {
			const pairUrl = new URL(request.url);
			pairUrl.searchParams.set("pairKey", pairKey);
			return pairService.fetch(new Request(pairUrl, request));
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return http(426, "Expected WebSocket");
		}
		const url = new URL(request.url);
		if (url.pathname === "/ws/pair") {
			return pendingPair(request, env);
		}
		if (url.pathname === "/ws/room") {
			const roomKey = url.searchParams.get("roomKey");
			if (!roomKey) {
				return http(400, "roomKey is empty");
			}
			return env.CHAT_ROOM.getByName(roomKey).fetch(request);
		}
		return new Response("WebSocket Server");
	},
};
