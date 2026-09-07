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

	constructor(state: DurableObjectState, env: Env) {
		super(state, env); this.state = state;
	}

	// register
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return http(426, "Expected WebSocket");
		}
		return this.state.blockConcurrencyWhile(async () => {
			const ws = this.state.getWebSockets()
				.find(it => it.readyState === WebSocket.OPEN);
			if (ws) {
				return http(409, "pairKey is already paired");
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.state.acceptWebSocket(server);
			return new Response(null, { status: 101, webSocket: client });
		});
	}

	async checkPairKeyExist(): Promise<boolean> {
		const wsList = this.state.getWebSockets()
			.filter(it => it.readyState === WebSocket.OPEN);
		return wsList.length > 0;
	}

	async prePair(targetPairKey: string, passcode: string) {
		const wsList = this.state.getWebSockets()
			.filter(it => it.readyState === WebSocket.OPEN);
		if (wsList.length === 0) {
			return http(409, "pairKey is not registered");
		}
		if (wsList.length > 1) {
			return http(409, "pairKey is paired");
		}
		const ownerWs = wsList[0];

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server);

		sendMsg(ownerWs, "WAITING_PAIR_CONFIRM", { passcode });
		sendMsg(server, "PAIR_STARTED", { passcode })

		return new Response(null, { status: 101, webSocket: client });
	}

	async pair() {
		const wsList = this.state.getWebSockets()
			.filter(it => it.readyState === WebSocket.OPEN);
		if (wsList.length < 2) {
			wsList.forEach(ws => {
				sendMsg(ws, "PAIR_FAIL", { error: "connection has been disconnected, unable to pair" });
			});
			return;
		}
		const [ selfWs, requesterWs ] = wsList;
		const roomKey = randomUUID();
		sendMsg(selfWs, "PAIR_SUCC", { roomKey });
		sendMsg(requesterWs, "PAIR_SUCC", { roomKey });
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
			await this.pair();
			return;
		}
		if (type === 'PAIR_REJECT') {
			const requesterWs = this.state.getWebSockets()
				.find(peer => peer !== ws);
			if (requesterWs) {
				sendMsg(requesterWs, "PAIR_REJECT");
			}
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
	const requestUrl = new URL(request.url);
	const targetPairKey = requestUrl.searchParams.get("targetPairKey");
	// pair workflow
	if (targetPairKey) {
		const passcode =  requestUrl.searchParams.get("passcode");
		if (!passcode) {
			return http(400, "passcode is missing");
		}
		return env.PAIRING.getByName(targetPairKey).prePair(targetPairKey, passcode);
	}
	// register pair workflow
	let pairKey: string;
	while (true) {
		pairKey = randomUUID();
		const pairService = env.PAIRING.getByName(pairKey);
		const registerResult = await pairService.checkPairKeyExist();
		if (!registerResult) {
			return pairService.fetch(request);
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
