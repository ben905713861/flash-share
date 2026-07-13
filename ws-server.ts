import {WebSocketServer} from 'ws';
import https from "https";
import fs from "fs";

const PORT = 8011;

const wsPendingMap = new Map();
const roomMap = new Map();
const roomMap2 = new Map();

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

const wss = new WebSocketServer({ server });
wss.on("connection", (ws, request) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    let reqBody;
    try {
      reqBody = JSON.parse(message.toString());
    } catch (e) {
      console.error("invalid request body", e);
      return;
    }
    const { type, data } = reqBody;
    if (!type) {
      console.warn('type cannot be null');
      return;
    }
    console.log("received type:", type);
    if (type === 'PENDING_PAIR') {
      const { pairKey } = data;
      if (!pairKey) {
        console.warn('pairKey is missing');
        return;
      }
      wsPendingMap.set(pairKey, ws);
      sendMsg(ws, 'PENDING_PAIR_SUCC');
      return;
    }
    if (type === 'PAIR') {
      const { targetPairKey } = data;
      if (!targetPairKey) {
        console.warn('target pairKey is missing');
        return;
      }
      const targetWs = wsPendingMap.get(targetPairKey);
      if (targetWs == null) {
        sendMsg(ws, 'PAIR_FAILED');
        return;
      }
      // generate connected ID
      const connectedId = crypto.randomUUID() + crypto.randomUUID();
      // create room
      roomMap.set(connectedId, []);
      sendMsg(ws, 'PAIR_SUCC', { connectedId });
      sendMsg(targetWs, 'PAIR_SUCC', { connectedId });
      return;
    }
    const { connectedId } = reqBody;
    if (!connectedId) {
      console.warn('connectedId is missing');
      return;
    }
    if (type === 'JOIN_ROOM') {
      let room = roomMap.get(connectedId);
      if (room == null) {
        room = []
        roomMap.set(connectedId, room);
      }
      room.push(ws);
      roomMap2.set(ws, connectedId);
      if (room.length <= 1) {
        sendMsg(ws, 'JOIN_ROOM_WAIT', { isOfferer: true });
      } else if (room.length == 2) {
        sendMsg(room[0], 'JOIN_ROOM_SUCC', { isOfferer: true });
        sendMsg(room[1], 'JOIN_ROOM_SUCC', { isOfferer: false });
      } else {
        console.warn("room is full")
        sendMsg(ws, 'JOIN_ROOM_FAIL');
      }
      return;
    }

    const list: WebSocket[] = roomMap.get(connectedId);
    if (list == null) {
      console.error('cannot find target ws, connectedId: ', connectedId);
      return;
    }
    const targetWsList: WebSocket[] = list.filter((item: any) => item !== ws);
    if (targetWsList.length === 0) {
      console.error("No connection found");
      return;
    }
    targetWsList.forEach((targetWs: WebSocket) => {
      if (targetWs.readyState !== WebSocket.OPEN) {
        console.error(`Connection failed: ${targetWs.toString()}`);
        return;
      }
      targetWs.send(message.toString());
    })
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    const connectId = roomMap2.get(ws);
    if (connectId) {
      let list = roomMap.get(connectId);
      list = list.filter((item: any) => item != ws);
      roomMap.set(connectId, list);
      roomMap2.delete(ws);
    }
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
  ws.send(JSON.stringify({ type, data }));
}