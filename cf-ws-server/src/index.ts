import {randomUUID} from "crypto";
import { ChatRoom } from "./chat-room";
import { PairingRoom } from "./pairing-room";

export { ChatRoom, PairingRoom };

async function pendingPair(request: Request, env: Env) {
	const requestUrl = new URL(request.url);
	const targetPairKey = requestUrl.searchParams.get("targetPairKey");
	// pair workflow
	if (targetPairKey) {
		const passcode =  requestUrl.searchParams.get("passcode");
		if (!passcode) {
			return new Response("passcode is missing", { status: 400 });
		}
		return env.PAIR_ROOM.getByName(targetPairKey).fetch(request);
	}
	// register pair workflow
	let pairKey: string;
	while (true) {
		pairKey = randomUUID();
		const pairService = env.PAIR_ROOM.getByName(pairKey);
		const registerResult = await pairService.checkPairKeyExist();
		if (!registerResult) {
			const registerUrl = new URL(request.url);
			registerUrl.searchParams.set("pairKey", pairKey);
			return pairService.fetch(new Request(registerUrl, request));
		}
	}
}

async function fetch(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return new Response("Expected WebSocket", { status: 426 });
	}
	const url = new URL(request.url);
	if (url.pathname === "/ws/pair") {
		return pendingPair(request, env);
	}
	if (url.pathname === "/ws/room") {
		const roomKey = url.searchParams.get("roomKey");
		if (!roomKey) {
			return new Response("roomKey is empty", { status: 400 });
		}
		return env.CHAT_ROOM.getByName(roomKey).fetch(request);
	}
	return new Response("WebSocket Server");
}

export default {
	fetch,
};
