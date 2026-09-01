import { DurableObject } from "cloudflare:workers";

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
		const isPaired = await this.state.storage.get<boolean>("isPaired");
		if (isPaired) {
			return http(409, "pairKey is already paired");
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		const anotherWs = this.state.getWebSockets()
			.find(it => it.readyState === WebSocket.OPEN);
		if (anotherWs) {
			if (anotherWs === server) {
				// scenario 1: ws uses same pair key to register multiple times
				sendMsg(server, "PENDING_PAIR_SUCC");
			} else {
				// scenario 2: another ws uses an in-used pariKey to register
				sendMsg(server, 'PENDING_PAIR_FAIL', { error: "pairKey is already registered" });
				server.close();
			}
		} else {
			this.state.acceptWebSocket(server);
			const pairKey = new URL(request.url).searchParams.get("pairKey")!;
			await this.state.storage.put("pairKey", pairKey);
			sendMsg(server, "PENDING_PAIR_SUCC");
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	async getPairKey(): Promise<string> {
		const pairKey = await this.state.storage.get<string>("pairKey");
		if (!pairKey) {
			throw new Error("pairKey didn't bind to DO");
		}
		return pairKey;
	}

	async notifyPaired(roomKey: string): Promise<boolean> {
		return this.state.blockConcurrencyWhile(async () => {
			const isPaired = await this.state.storage.get<boolean>("isPaired");
			if (isPaired) {
				return false;
			}
			const ws: WebSocket | undefined = this.state.getWebSockets()
				.find(it => it.readyState === WebSocket.OPEN);
			if (ws) {
				await this.state.storage.put("isPaired", true);
				sendMsg(ws, "PAIR_SUCC", { roomKey });
				return true;
			}
			return false;
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
		if (type === 'PAIR') {
			const { targetPairKey } = data;
			await this.pair(ws, targetPairKey);
		}
	}

	async pair(ws: WebSocket, targetPairKey?: string) {
		if (!targetPairKey) {
			sendMsg(ws, 'ERROR', { error: 'targetPairKey is missing' });
			return;
		}
		try {
			const targetStub = this.environment.PAIRING.getByName(targetPairKey);
			const pairKey = await this.getPairKey();
			if (pairKey === targetPairKey) {
				sendMsg(ws, 'PAIR_FAIL', { error: "unable to pair with same ws。" });
				return;
			}
			const roomKey = crypto.randomUUID();
			const isPairSuccess = await targetStub.notifyPaired(roomKey);
			if (!isPairSuccess) {
				sendMsg(ws, 'PAIR_FAIL', { error: "pairKey is not registered." });
				return;
			}
			sendMsg(ws, "PAIR_SUCC", { roomKey });
		} catch (e) {
			if (e instanceof Error) {
				console.error('register pairKey failed', e);
				sendMsg(ws, 'PAIR_FAIL', { error: e.message });
			}
		}
	}

	async webSocketClose(ws: WebSocket) {
		await this.state.storage.delete("isPaired");
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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return http(426, "Expected WebSocket");
		}
		const url = new URL(request.url);
		if (url.pathname === "/ws/pair") {
			const pairKey = url.searchParams.get("pairKey");
			if (!pairKey) {
				return http(400, "pairKey is empty");
			}
			return env.PAIRING.getByName(pairKey).fetch(request);
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
