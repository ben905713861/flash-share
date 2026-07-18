import {WebSocket} from 'ws';

export default class RoomService {
    #roomKey2roomMap: Map<string, Room> = new Map();
    #ws2roomMap: Map<WebSocket, Room> = new Map();

    constructor() {
        setInterval(this.#clear, 3600 * 1000);
    }

    createRoom(): string {
        const roomKey = crypto.randomUUID() + crypto.randomUUID();
        const room = new Room(roomKey, [], new Date());
        this.#roomKey2roomMap.set(roomKey, room);
        return roomKey;
    }

    joinRoom(roomKey: string, ws: WebSocket) {
        const room: Room = this.getRoomInfo(roomKey);
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
        this.#ws2roomMap.set(ws, room);
        room.lastConnectTime = new Date();
    }

    getRoomInfo(roomKey: string): Room {
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

    leaveRoom(ws: WebSocket) {
        const room: Room | undefined = this.#ws2roomMap.get(ws);
        if (room) {
            room.wsList = room.wsList.filter((item: WebSocket) => item != ws);
            this.#ws2roomMap.delete(ws);
            room.lastConnectTime = new Date();
        }
    }

    #clear() {
        this.#ws2roomMap.forEach((room: Room, ws: WebSocket) => {
            if (ws.readyState !== WebSocket.OPEN) {
                room.wsList = room.wsList.filter((item: WebSocket) => item != ws);
                this.#ws2roomMap.delete(ws);
            }
        });
        this.#roomKey2roomMap.forEach((room: Room, roomKey: string) => {
            if (room.wsList.length === 0) {
                if (Date.now() - room.lastConnectTime.getTime() > 3600 * 1000) {
                    this.#roomKey2roomMap.delete(roomKey);
                }
            }
        });
    }
}

class Room {
    constructor(public roomKey: string,
                public wsList: WebSocket[],
                public lastConnectTime: Date) {
        this.roomKey = roomKey;
        this.wsList = wsList;
        this.lastConnectTime = lastConnectTime;
    }
}
