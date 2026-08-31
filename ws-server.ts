import {WebSocketServer, WebSocket, RawData} from 'ws';
import https from "https";
import fs from "fs";
import RoomService from "./room-service";
import {PairService} from "./pair-service";
import MessageRateService from "./message-rate-service";

const PORT = 8011;
const MAX_CONNECTIONS = 200;
const MAX_PAYLOAD_BYTES = 256 * 1024;

const server = https.createServer({
  cert: fs.readFileSync("./cert/fullchain.pem"),
  key: fs.readFileSync("./cert/privkey.pem"),
});

const messageRateService = new MessageRateService();
const pairService = new PairService();
const roomService = new RoomService();

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

wss.on("connection", (ws: WebSocket, request) => {
  if (wss.clients.size > MAX_CONNECTIONS) {
    ws.close(1013, "Server is at connection capacity");
    return;
  }
  console.log("Client connected");

  if (!request.url) {
    ws.close(1008, "path is empty");
    return;
  }

  const url = new URL(request.url.toString(), `https://${request.headers.host}`);

  if (url.pathname === "/ws/pair") {
    const pairKey = url.searchParams.get("pairKey");
    if (!pairKey) {
      ws.close(1008, "pairKey is empty");
      return;
    }

    ws.on("message", (message) => {
      if (messageRateService.isRateLimited(ws)) {
        ws.close(1008, "Too many messages");
        return;
      }
      console.log("ws received", message.toString());
      handleMessage(ws, message);
    });

    pendingPair(ws, pairKey);

  } else if (url.pathname === "/ws/room") {
    const roomKey = url.searchParams.get("roomKey");
    if (!roomKey) {
      ws.close(1008, "roomKey is empty");
      return;
    }

    ws.on("message", (message) => {
      if (messageRateService.isRateLimited(ws)) {
        ws.close(1008, "Too many messages");
        return;
      }
      console.log("ws received", message.toString());
      handleMessage(ws, message);
    });

    joinRoom(ws, roomKey);

  } else {
    ws.close(1008, "path is not existed");
    return;
  }

  ws.on("close", () => {
    console.log("Client disconnected");
    roomService.leaveRoom(ws);
    pairService.unregister(ws);
  });

  ws.on("error", (error) => {
    console.warn("WebSocket connection error:", error.message);
  });
});

// HTTP + WebSocket 共用8011端口
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

wss.on('listening', () => {
  console.log(`WebSocket server listening on ${PORT}`);
});

wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

function sendMsg(ws: any, type: string, data?: any) {
  if (ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not open, cannot send message');
  }
  ws.send(JSON.stringify({ type, data }));
}

function handleMessage(ws: WebSocket, message: RawData) {
  let reqBody;
  try {
    reqBody = JSON.parse(message.toString());
  } catch (e) {
    if (e instanceof Error) {
      console.error('invalid request body', message.toString(), e);
      sendMsg(ws, 'ERROR', { error: 'invalid request body' });
    }
    return;
  }
  if (reqBody == null || reqBody instanceof Array) {
    console.error('invalid request body', reqBody);
    return;
  }
  const { type, data } = reqBody;
  if (!type) {
    console.warn('type cannot be null');
    return;
  }
  if (!data) {
    console.warn('data cannot be null');
    return;
  }
  console.log("received type:", type);
  if (type === 'PAIR') {
    const { targetPairKey } = data;
    pair(ws, targetPairKey);
    return;
  }

  const { roomKey } = reqBody;
  if (!roomKey) {
    console.warn('roomKey is missing');
    sendMsg(ws, 'ERROR', { error: 'roomKey is missing' });
    return;
  }
  try {
    roomService.validateRoomKey(roomKey);
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Invalid roomKey';
    console.warn('roomKey validation failed', error);
    sendMsg(ws, type === 'JOIN_ROOM' ? 'JOIN_ROOM_FAIL' : 'ERROR', { error });
    return;
  }

  // other types
  try {
    const roomWsList: WebSocket[] = roomService.getRoomWsList(roomKey);
    if (roomWsList.indexOf(ws) < 0) {
      sendMsg(ws, 'ERROR', { error: 'roomKey does not match ws' });
      return;
    }
    const targetWsList: WebSocket[] = roomWsList.filter((item: WebSocket) => item !== ws);
    targetWsList.forEach((targetWs: WebSocket) => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(message.toString());
      }
    });
  } catch (e) {
    if (e instanceof Error) {
      console.error('exchange ws message error', e);
      sendMsg(ws, 'ERROR', { error: e.message });
    }
  }
}

function pendingPair(ws: WebSocket, pairKey: string) {
  try {
    pairService.register(pairKey, ws);
    sendMsg(ws, 'PENDING_PAIR_SUCC');
  } catch (e) {
    if (e instanceof Error) {
      console.error('register pairKey failed', e);
      sendMsg(ws, 'PENDING_PAIR_FAIL', { error: e.message });
      ws.close();
    }
  }
}

function pair(ws: WebSocket, targetPairKey?: string) {
  if (!targetPairKey) {
    sendMsg(ws, 'ERROR', { error: 'targetPairKey is missing' });
    return;
  }
  try {
    const targetWs: WebSocket = pairService.pair(targetPairKey, ws);
    const roomKey = roomService.createRoom();
    sendMsg(targetWs, 'PAIR_SUCC', { roomKey });
    sendMsg(ws, 'PAIR_SUCC', { roomKey });
  } catch (e) {
    if (e instanceof Error) {
      console.error('register pairKey failed', e);
      sendMsg(ws, 'PAIR_FAIL', { error: e.message });
    }
  }
}

function joinRoom(ws: WebSocket, roomKey: string) {
  try {
    roomService.joinRoom(roomKey, ws);
    const roomWsList: WebSocket[] = roomService.getRoomWsList(roomKey);
    if (roomWsList.length == 1) {
      sendMsg(ws, 'JOIN_ROOM_WAIT');
    } else {
      for (let i = 0; i < roomWsList.length; i++) {
        sendMsg(roomWsList[i], 'JOIN_ROOM_SUCC', { isOfferer: i == 0 });
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      console.error('join room error', e);
      sendMsg(ws, 'JOIN_ROOM_FAIL', { error: e.message });
    }
  }
}
