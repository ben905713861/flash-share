import { DurableObject } from "cloudflare:workers";

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject<Env> {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * The Durable Object exposes an RPC method sayHello which will be invoked when a Durable
	 *  Object instance receives a request from a Worker via the same method invocation on the stub
	 *
	 * @param name - The name provided to a Durable Object instance from a Worker
	 * @returns The greeting to be sent back to the Worker
	 */
	async sayHello(name: string): Promise<string> {
		return `Hello, ${name}!`;
	}
}

export class ChatRoom {
	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("Expected WebSocket", {
				status: 426,
			});
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// add ws to DO
		this.state.acceptWebSocket(server);

		server.serializeAttachment({
			connectedAt: Date.now(),
		});

		server.send(
			JSON.stringify({
				type: "connected",
				message: "WebSocket connected",
			}),
		);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	) {
		const text =
			typeof message === "string"
				? message
				: new TextDecoder().decode(message);

		console.log("收到消息:", text);

		// 获取当前 Durable Object 管理的所有 WebSocket
		const sockets = this.state.getWebSockets();

		for (const socket of sockets) {
			// 不发送给自己
			if (socket === ws) {
				continue;
			}

			const info = socket.deserializeAttachment();

			const { connectedAt } = info;

			try {
				socket.send(
					JSON.stringify({
						type: "message",
						data: text,
						connectedAt,
					}),
				);
			} catch (error) {
				console.error("发送失败:", error);
			}
		}
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	) {
		console.log("WebSocket closed", {
			code,
			reason,
			wasClean,
		});
	}

	async webSocketError(
		ws: WebSocket,
		error: unknown,
	) {
		console.error("WebSocket error:", error);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("Expected WebSocket", { status: 426 });
			}

			// 根据 room 参数决定进入哪个房间
			const room = url.searchParams.get("room") || "default";

			const stub = env.CHAT_ROOM.getByName(room);

			return stub.fetch(request);
		}

		return new Response("WebSocket Server");
	},
};
