import { DurableObject } from "cloudflare:workers";
import { verifyRoomKey } from "./room-key";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 100;

type ChatAttachment = {
	windowStartedAt: number;
	messageCount: number;
};

function sendMsg(ws: WebSocket, type: string, data?: unknown) {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type, data }));
	}
}

function messageByteLength(message: string | ArrayBuffer): number {
	return typeof message === "string"
		? new TextEncoder().encode(message).byteLength
		: message.byteLength;
}

export class ChatRoom extends DurableObject<Env> {
	private readonly state: DurableObjectState;
	constructor(state: DurableObjectState, env: Env) { super(state, env); this.state = state; }

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const roomKey = new URL(request.url).searchParams.get("roomKey");
		if (!roomKey) {
			return this.wsReturnError("roomKey is empty");
		}
		try {
			verifyRoomKey(roomKey, this.env.ROOM_KEY_SECRET);
		} catch {
			return this.wsReturnError("Invalid or expired roomKey");
		}

		return this.state.blockConcurrencyWhile(async () => {
			const wsList = this.state.getWebSockets()
				.filter(ws => ws.readyState === WebSocket.OPEN);
			if (wsList.length >= 2) {
				return this.wsReturnError("room is full");
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.state.acceptWebSocket(server);
			server.serializeAttachment({
				windowStartedAt: Date.now(),
				messageCount: 0,
			} satisfies ChatAttachment);

			this.joinRoom();
			return new Response(null, { status: 101, webSocket: client });
		});
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
		if (messageByteLength(message) > MAX_MESSAGE_BYTES) {
			sendMsg(ws, "ERROR", { error: "message is too large" });
			ws.close(1009, "message too large");
			return;
		}

		const now = Date.now();
		const attachment = this.getAttachment(ws);
		const rate = attachment ?? { windowStartedAt: now, messageCount: 0 };
		if (now - rate.windowStartedAt >= MESSAGE_RATE_WINDOW_MS) {
			rate.windowStartedAt = now;
			rate.messageCount = 0;
		}
		if (rate.messageCount >= MAX_MESSAGES_PER_WINDOW) {
			sendMsg(ws, "ERROR", { error: "message rate limit exceeded" });
			ws.close(1013, "message rate limit exceeded");
			return;
		}
		rate.messageCount += 1;
		ws.serializeAttachment(rate);

		// forward
		const targetWsList = this.state.getWebSockets()
			.filter(peer => peer.readyState === WebSocket.OPEN)
			.filter(peer => peer !== ws);
		targetWsList.forEach((targetWs) => {
			targetWs.send(message);
		})
	}

	private getAttachment(ws: WebSocket): ChatAttachment | null {
		return ws.deserializeAttachment() as ChatAttachment | null;
	}

	private wsReturnError(error: string) {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server);
		server.close(1008, error);
		return new Response(null, {status: 101, webSocket: client});
	}

}
