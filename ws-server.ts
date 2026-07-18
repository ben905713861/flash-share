import {WebSocketServer, WebSocket} from 'ws';
import https from "https";
import fs from "fs";
import RoomService from "./room-service";
import {PairService} from "./pair-service";

const PORT = 8011;

const options = {
  key: fs.readFileSync("./cert/privkey.pem"),
  cert: fs.readFileSync("./cert/fullchain.pem")
};

const server = https.createServer(options, (req, res) => {
  if (req.url === "/") {
    fs.readFile("./webrtc.html", (err, data) => {
      res.writeHead(200, {
        "Content-Type": "text/html"
      });
      res.end(data);
    });
  }
});

const pairService = new PairService();
const roomService = new RoomService();
const wss = new WebSocketServer({ server });
wss.on("connection", (ws: WebSocket, request) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    let reqBody;
    try {
      reqBody = JSON.parse(message.toString());
    } catch (e) {
      console.error("invalid request body", message.toString(), e);
      return;
    }
    if (reqBody == null || reqBody instanceof Array) {
      console.error("invalid request body", reqBody);
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
    if (type === 'PENDING_PAIR') {
      const { pairKey } = data;
      if (!pairKey) {
        console.warn('pairKey is missing');
        return;
      }
      try {
        pairService.register(pairKey, ws);
        sendMsg(ws, 'PENDING_PAIR_SUCC');
      } catch (e) {
        console.error('register pairKey failed', e);
      }
      return;
    }
    if (type === 'PAIR') {
      const { targetPairKey } = data;
      if (!targetPairKey) {
        console.warn('target pairKey is missing');
        return;
      }
      try {
        const targetWs: WebSocket = pairService.pair(targetPairKey, ws);
        const roomKey = roomService.createRoom();
        sendMsg(ws, 'PAIR_SUCC', { roomKey });
        sendMsg(targetWs, 'PAIR_SUCC', { roomKey });
      } catch (e) {
        console.error('register pairKey failed', e);
        sendMsg(ws, 'PAIR_FAIL');
      }
      return;
    }

    const { roomKey } = reqBody;
    if (!roomKey) {
      console.warn('roomKey is missing');
      return;
    }
    if (type === 'JOIN_ROOM') {
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
        console.error('join room error', e);
        sendMsg(ws, 'JOIN_ROOM_FAIL');
      }
      return;
    }
    // other types
    try {
      const roomWsList: WebSocket[] = roomService.getRoomWsList(roomKey);
      const targetWsList: WebSocket[] = roomWsList.filter((item: WebSocket) => item !== ws);
      targetWsList.forEach((targetWs: WebSocket) => {
        if (targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(message.toString());
        }
      })
    } catch (e) {
      console.error('exchange ws message error', e);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    roomService.leaveRoom(ws);
    pairService.unregister(ws);
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
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  } else {
    console.error('WebSocket is not open, cannot send message');
  }
}