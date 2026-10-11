import { DurableObject } from "cloudflare:workers";
import { verifyRoomKey } from "./room-key";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 100;

type ChatAttachment = {
	windowStartedAt: number;
	messageCount: number;
	isOfferer: boolean;
	deviceId: string;
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
		const requestUrl = new URL(request.url);
		const roomKey = requestUrl.searchParams.get("roomKey");
		const deviceId = requestUrl.searchParams.get("deviceId");
		if (!roomKey) {
			return this.wsReturnError("roomKey is empty");
		}
		if (!deviceId) {
			return this.wsReturnError("deviceId is empty");
		}
		try {
			verifyRoomKey(roomKey, this.env.ROOM_KEY_SECRET);
		} catch {
			return this.wsReturnError("Invalid or expired roomKey");
		}

		return this.state.blockConcurrencyWhile(async () => {
			const allWs = this.state.getWebSockets();
			const replacedWs = allWs.filter(ws =>
				this.getAttachment(ws)?.deviceId === deviceId
			);
			const otherDeviceIds = new Set(
				allWs
					.map(ws => this.getAttachment(ws))
					.filter(attachment => attachment !== null)
					.map(attachment => attachment.deviceId)
					.filter(id => id !== deviceId),
			);
			const isOfferer = replacedWs
				.map(ws => this.getAttachment(ws))
				.find(attachment => attachment !== null)
				?.isOfferer
				?? otherDeviceIds.size === 0;

			replacedWs.forEach(ws => ws.close(1000, "replaced by reconnect"));
			if (otherDeviceIds.size >= 2) {
				return this.wsReturnError("room is full");
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			this.state.acceptWebSocket(server);
			server.serializeAttachment({
				windowStartedAt: Date.now(),
				messageCount: 0,
				isOfferer,
				deviceId,
			} satisfies ChatAttachment);

			this.joinRoom(server);
			return new Response(null, { status: 101, webSocket: client });
		});
	}

	private joinRoom(currentWs: WebSocket) {
		const wsByDevice = new Map<string, WebSocket>();
		for (const ws of this.state.getWebSockets()) {
			if (ws.readyState !== WebSocket.OPEN) {
				continue;
			}
			const deviceId = this.getAttachment(ws)?.deviceId;
			if (!deviceId || wsByDevice.has(deviceId)) {
				continue;
			}
			wsByDevice.set(deviceId, ws);
		}

		const currentDeviceId = this.getAttachment(currentWs)?.deviceId;
		if (currentDeviceId) {
			wsByDevice.set(currentDeviceId, currentWs);
		}
		const wsList = [...wsByDevice.values()];
		if (wsList.length === 1) {
			sendMsg(wsList[0], "JOIN_ROOM_WAIT");
		} else {
			wsList.forEach((ws) => {
				const attachment = this.getAttachment(ws);
				sendMsg(ws, "JOIN_ROOM_SUCC", { isOfferer: attachment?.isOfferer });
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
		if (!attachment) {
			ws.close(1008, "missing connection attachment");
			return;
		}
		const rate = attachment;
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
		});
	}

	async webSocketClose(_ws: WebSocket) {
		await this.state.blockConcurrencyWhile(async () => {
			const wsByDevice = new Map<string, WebSocket>();
			this.state.getWebSockets()
				.filter(ws => ws.readyState === WebSocket.OPEN)
				.forEach((ws) => {
					const deviceId = this.getAttachment(ws)?.deviceId;
					if (deviceId && !wsByDevice.has(deviceId)) {
						wsByDevice.set(deviceId, ws);
					}
				});
			const wsList = [...wsByDevice.values()];
			if (wsList.length !== 1) {
				return;
			}

			// If the current offerer leaves, the remaining connection must take
			// over so the next join can establish a new WebRTC offer.
			const remainingWs = wsList[0];
			const attachment = this.getAttachment(remainingWs);
			if (!attachment) {
				return;
			}
			remainingWs.serializeAttachment({
				windowStartedAt: attachment.windowStartedAt,
				messageCount: attachment.messageCount,
				isOfferer: true,
				deviceId: attachment.deviceId,
			} satisfies ChatAttachment);
		});
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
