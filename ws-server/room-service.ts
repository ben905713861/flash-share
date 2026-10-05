import {WebSocket} from 'ws';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import {randomUUID} from "crypto";

function readRoomSecret(): string {
    const value = process.env.ROOM_KEY_SECRET;
    if (!value) {
        throw new Error('ROOM_KEY_SECRET environment variable is required');
    }
    return value;
}

export default class RoomService {
    #roomKey2roomMap: Map<string, Room> = new Map();
    #ws2roomMap: Map<WebSocket, Room> = new Map();

    createRoom(): string {
        return jwt.sign({}, readRoomSecret(), {
            algorithm: "HS256",
            expiresIn: "30d",
            jwtid: randomUUID(),
        });
    }

    joinRoom(roomKey: string, ws: WebSocket) {
        this.validateRoomKey(roomKey);
        const room: Room = this.#roomKey2roomMap.get(roomKey) ?? { roomKey, wsList: [] };
        room.wsList = room.wsList.filter((item: WebSocket) => item.readyState === WebSocket.OPEN);

        // scenario 2, send duplicated request (same roomKey and ws) to join same room
        let roomIndex = room.wsList.indexOf(ws);
        if (roomIndex >= 0) {
            return;
        }
        // scenario 3, a joined-room ws uses another roomKey to join again
        const _room: Room | undefined =  this.#ws2roomMap.get(ws);
        if (_room && _room.roomKey !== roomKey) {
            throw new Error('Unable to joinRoom, already joined another room');
        }
        // scenario 4: room is full
        if (room.wsList.length >= 2) {
            throw new Error('Unable to joinRoom, room is full');
        }
        room.wsList.push(ws);
        this.#roomKey2roomMap.set(roomKey, room);
        this.#ws2roomMap.set(ws, room);
    }

    validateRoomKey(roomKey: string) {
        jwt.verify(roomKey, readRoomSecret(), { algorithms: ["HS256"] });
    }

    getRoomInfo(roomKey: string): Room {
        this.validateRoomKey(roomKey);
        const room: Room | undefined = this.#roomKey2roomMap.get(roomKey);
        // scenario 1. send wrong roomKey
        if (!room) {
            throw new Error('Unable to fetch room info, room does not exist, roomKey: ' + roomKey);
        }
        return room;
    }

    getRoomWsList(roomKey: string): WebSocket[] {
        const room: Room = this.getRoomInfo(roomKey);
        return room.wsList;
    }

    getOtherRoomWs(ws: WebSocket): WebSocket[] {
        const room: Room | undefined = this.#ws2roomMap.get(ws);
        if (!room) {
            throw new Error("Unable to fetch room info, roomKey does not exist");
        }
        return room.wsList;
    }

    leaveRoom(ws: WebSocket) {
        const room: Room | undefined = this.#ws2roomMap.get(ws);
        if (room) {
            room.wsList = room.wsList.filter((item: WebSocket) => item != ws);
            this.#ws2roomMap.delete(ws);
            if (room.wsList.length === 0) {
                this.#roomKey2roomMap.delete(room.roomKey);
            }
        }
    }
}

type Room = {
    roomKey: string;
    wsList: WebSocket[];
}
