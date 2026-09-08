import { DurableObject } from "cloudflare:workers";

function sendMsg(ws: WebSocket, type: string, data?: unknown) {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type, data }));
	}
}

export class ChatRoom extends DurableObject<Env> {
	private readonly state: DurableObjectState;
	constructor(state: DurableObjectState, env: Env) { super(state, env); this.state = state; }

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const wsList = this.state.getWebSockets()
			.filter(ws => ws.readyState === WebSocket.OPEN);
		if (wsList.length >= 2) {
			return new Response("room is full", { status: 1013 });
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
