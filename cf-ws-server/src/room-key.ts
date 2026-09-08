import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";

declare global {
	interface Env {
		ROOM_KEY_SECRET: string;
	}
}

export function createRoomKey(secret: string): string {
	return jwt.sign({}, secret, {
		algorithm: "HS256",
		expiresIn: "30d",
		jwtid: randomUUID(),
	});
}

export function verifyRoomKey(roomKey: string, secret: string): void {
	jwt.verify(roomKey, secret, { algorithms: ["HS256"] });
}
