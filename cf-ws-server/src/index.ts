import { DurableObject } from "cloudflare:workers";
import {randomUUID} from "crypto";

type PairAttachment = {
	role: "owner" | "requester";
	status: "registered" | "pending" | "paired";
	roomKey?: string;
};

function sendMsg(ws: WebSocket, type: string, data?: unknown) {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type, data }));
	}
}

function http(status: number, body: string) {
	return new Response(body, { status });
}

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
			server.serializeAttachment({
				role: "owner",
				status: "registered"
			} satisfies PairAttachment);
			return new Response(null, { status: 101, webSocket: client });
		});
	}

	async checkPairKeyExist(): Promise<boolean> {
		const wsList = this.state.getWebSockets()
			.filter(it => it.readyState === WebSocket.OPEN);
		return wsList.length > 0;
	}

	async prePair(passcode: string) {
		return this.state.blockConcurrencyWhile(async () => {
			const wsList = this.state.getWebSockets()
				.filter(it => it.readyState === WebSocket.OPEN);
			if (wsList.length === 0) {
				return http(409, "pairKey is not registered");
			}
			if (wsList.length > 1) {
				return http(409, "pairKey is paired");
			}
			const ownerWs = wsList[0];
			const ownerAttachment = this.getPairAttachment(ownerWs);
			if (ownerAttachment?.role !== "owner" || ownerAttachment?.status !== "registered") {
				return http(409, "pairKey is already pending");
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.state.acceptWebSocket(server);
			ownerWs.serializeAttachment({ role: "owner", status: "pending" } satisfies PairAttachment);
			server.serializeAttachment({ role: "requester", status: "pending" } satisfies PairAttachment);

			sendMsg(ownerWs, "WAITING_PAIR_CONFIRM", { passcode });
			sendMsg(server, "PAIR_STARTED", { passcode });

			return new Response(null, { status: 101, webSocket: client });
		});
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		let reqBody;
		const messageString = typeof message === "string" ? message : new TextDecoder().decode(message);
		try {
			reqBody = JSON.parse(messageString);
		} catch (e) {
			if (e instanceof Error) {
				console.error('invalid request body', messageString, e);
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

		await this.state.blockConcurrencyWhile(async () => {
			if (type === 'PAIR_CONFIRM') {
				await this.pair(ws);
			} else if (type === 'PAIR_REJECT') {
				this.pairReject(ws);
			}
		});
	}

	private async pair(ownerWs: WebSocket) {
		const ownerAtt = this.getPairAttachment(ownerWs);
		if (ownerAtt === null || ownerAtt.role !== "owner" || ownerAtt.status !== "pending") {
			sendMsg(ownerWs, "PAIR_FAIL", { error: "only owner can confirm pairing" });
			return;
		}
		const requesterWs = this.state.getWebSockets()
			.filter(it => it.readyState === WebSocket.OPEN)
			.find(it => {
				const attachment = this.getPairAttachment(it);
				return attachment?.role === "requester" && attachment?.status === "pending";
			});
		if (!requesterWs) {
			ownerWs.serializeAttachment({ role: "owner", status: "registered" } satisfies PairAttachment);
			sendMsg(ownerWs, "PAIR_FAIL", { error: "connection has been disconnected, unable to pair" });
			return;
		}
		const roomKey = randomUUID();
		ownerWs.serializeAttachment({ role: "owner", status: "paired", roomKey } satisfies PairAttachment);
		requesterWs.serializeAttachment({ role: "requester", status: "paired", roomKey } satisfies PairAttachment);
		sendMsg(ownerWs, "PAIR_SUCC", { roomKey });
		sendMsg(requesterWs, "PAIR_SUCC", { roomKey });
	}

	private pairReject(ws: WebSocket) {
		const ownerAttr = this.getPairAttachment(ws);
		if (ownerAttr === null || ownerAttr.role !== "owner" || ownerAttr.status !== "pending") {
			sendMsg(ws, "ERROR", {error: "only pending owner can reject pairing"});
			return;
		}
		const requesterWs = this.state.getWebSockets()
			.filter(peer => peer.readyState === WebSocket.OPEN)
			.find(peer => {
				const attachment = this.getPairAttachment(peer);
				return attachment?.role === "requester" && attachment.status === "pending";
			});
		if (requesterWs) {
			sendMsg(requesterWs, "PAIR_REJECT");
			requesterWs.close(1000, "pairing rejected");
		}
		ws.serializeAttachment({role: "owner", status: "registered"} satisfies PairAttachment);
	}

	async webSocketClose(ws: WebSocket) {
		const attachment = this.getPairAttachment(ws);
		if (attachment?.role === "requester" && attachment.status === "pending") {
			const ownerWs = this.state.getWebSockets()
				.filter(peer => peer.readyState === WebSocket.OPEN)
				.find(peer => {
					const attachment = this.getPairAttachment(peer);
					return attachment?.role === "owner" && attachment.status === "pending";
				});
			ownerWs?.serializeAttachment({ role: "owner", status: "registered" } satisfies PairAttachment);
		}
	}

	private getPairAttachment(ws: WebSocket): PairAttachment | null {
		return ws.deserializeAttachment() as PairAttachment | null;
	}
}

export class ChatRoom extends DurableObject<Env> {
	private readonly state: DurableObjectState;
	constructor(state: DurableObjectState, env: Env) { super(state, env); this.state = state; }

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return http(426, "Expected WebSocket");
		}
		const wsList = this.state.getWebSockets()
			.filter(ws => ws.readyState === WebSocket.OPEN);
		if (wsList.length >= 2) {
			return http(1013, "room is full");
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server);

		this.joinRoom();
		return new Response(null, { status: 101, webSocket: client });
	}

	private joinRoom() {
		const wsList = this.state.getWebSockets()
			.filter(ws => ws.readyState === WebSocket.OPEN);
		if (wsList.length === 1) {
			sendMsg(wsList[0], "JOIN_ROOM_WAIT");
		} else {
			wsList.forEach((item, index) => {
				sendMsg(item, "JOIN_ROOM_SUCC", {isOfferer: index === 0})
			});
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		// forward
		const targetWsList = this.state.getWebSockets()
			.filter(peer => peer.readyState === WebSocket.OPEN)
			.filter(peer => peer !== ws);
		targetWsList.forEach((targetWs) => {
			targetWs.send(message);
		})
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
		return env.PAIRING.getByName(targetPairKey).prePair(passcode);
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
