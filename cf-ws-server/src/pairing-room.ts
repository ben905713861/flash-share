import { DurableObject } from "cloudflare:workers";
import { createRoomKey } from "./room-key";

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

export class PairingRoom extends DurableObject<Env> {
	private readonly state: DurableObjectState;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env); this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const requestUrl = new URL(request.url);
		if (requestUrl.searchParams.has("targetPairKey")) {
			// pair
			const passcode = requestUrl.searchParams.get("passcode")!;
			return this.prePair(passcode);
		}
		// register
		return this.registerPair(requestUrl);
	}

	private registerPair(requestUrl: URL) {
		const pairKey = requestUrl.searchParams.get("pairKey");
		if (!pairKey) {
			return this.wsReturnError("pairKey is null");
		}
		return this.state.blockConcurrencyWhile(async () => {
			const ws = this.state.getWebSockets()
				.find(it => it.readyState === WebSocket.OPEN);
			if (ws) {
				return this.wsReturnError("pairKey is already paired");
			}
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.state.acceptWebSocket(server);
			server.serializeAttachment({
				role: "owner",
				status: "registered"
			} satisfies PairAttachment);
			sendMsg(server, "PENDING_PAIR_SUCC", { pairKey });
			return new Response(null, {status: 101, webSocket: client});
		});
	}

	async checkPairKeyExist(): Promise<boolean> {
		const wsList = this.state.getWebSockets()
			.filter(it => it.readyState === WebSocket.OPEN);
		return wsList.length > 0;
	}

	private async prePair(passcode: string) {
		return this.state.blockConcurrencyWhile(async () => {
			const wsList = this.state.getWebSockets()
				.filter(it => it.readyState === WebSocket.OPEN);
			if (wsList.length === 0) {
				return this.wsReturnError("pairKey is not registered");
			}
			if (wsList.length > 1) {
				return this.wsReturnError("pairKey is paired");
			}
			const ownerWs = wsList[0];
			const ownerAttachment = this.getPairAttachment(ownerWs);
			if (ownerAttachment?.role !== "owner" || ownerAttachment?.status !== "registered") {
				return this.wsReturnError("pairKey is already pending");
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
		let reqBody: unknown;
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
		if (reqBody == null || typeof reqBody !== "object" || Array.isArray(reqBody)) {
			sendMsg(ws, "ERROR", { error: "invalid request body" });
			return;
		}
		const body = reqBody as Record<string, unknown>;
		const { type, data } = body;
		if (typeof type !== "string" || type.length === 0) {
			sendMsg(ws, "ERROR", { error: "Unsupported message on pair connection" });
			return;
		}
		if (!Object.prototype.hasOwnProperty.call(body, "data") || data == null) {
			sendMsg(ws, "ERROR", { error: "data cannot be null" });
			return;
		}
		console.log("received type:", type);

		await this.state.blockConcurrencyWhile(async () => {
			if (type === 'PAIR_CONFIRM') {
				await this.pair(ws);
			} else if (type === 'PAIR_REJECT') {
				this.pairReject(ws);
			} else {
				sendMsg(ws, "ERROR", { error: "unsupported message type" });
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
		const roomKey = createRoomKey(this.env.ROOM_KEY_SECRET);
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
		await this.state.blockConcurrencyWhile(async () => {
			const attachment = this.getPairAttachment(ws);
			if (attachment?.role === "requester" && attachment.status === "pending") {
				const ownerWs = this.state.getWebSockets()
					.filter(peer => peer.readyState === WebSocket.OPEN)
					.find(peer => {
						const attachment = this.getPairAttachment(peer);
						return attachment?.role === "owner" && attachment.status === "pending";
					});
				ownerWs?.serializeAttachment({ role: "owner", status: "registered" } satisfies PairAttachment);
			} else if (attachment?.role === "owner" && attachment.status === "pending") {
				const requesterWs = this.state.getWebSockets()
					.filter(peer => peer.readyState === WebSocket.OPEN)
					.find(peer => {
						const attachment = this.getPairAttachment(peer);
						return attachment?.role === "requester" && attachment.status === "pending";
					});
				if (requesterWs) {
					sendMsg(requesterWs, "PAIR_FAIL", { error: "owner disconnected" });
					requesterWs.close(1000, "owner disconnected");
				}
			}
		});
	}

	private getPairAttachment(ws: WebSocket): PairAttachment | null {
		return ws.deserializeAttachment() as PairAttachment | null;
	}

	private wsReturnError(error: string) {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server)
		server.close(1008, error);
		return new Response(null, {status: 101, webSocket: client});
	}
}
