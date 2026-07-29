import {WebSocketServer, WebSocket} from 'ws';
import https from "https";
import fs from "fs";
import path from "path";
import RoomService from "./room-service";
import {PairService} from "./pair-service";
import MessageRateService from "./message-rate-service";

const PORT = 8011;
const MAX_CONNECTIONS = 200;
const MAX_PAYLOAD_BYTES = 256 * 1024;

const options = {
  key: fs.readFileSync("./cert/privkey.pem"),
  cert: fs.readFileSync("./cert/fullchain.pem")
};

const server = https.createServer(options, (req, res) => {
  const urlPath = new URL(req.url ?? "/", `https://${req.headers.host ?? "localhost"}`).pathname;
  const requestPath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  const distDir = path.resolve("h5/dist");
  const filePath = path.resolve(distDir, requestPath ?? "index.html");
  if (!filePath.startsWith(distDir + path.sep) && filePath !== distDir) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Build the web client with npm run build first.");
      return;
    }
    const contentType = filePath.endsWith(".js")
      ? "application/javascript"
      : filePath.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/html; charset=utf-8";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

const messageRateService = new MessageRateService();
const pairService = new PairService();
const roomService = new RoomService();
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }, done) => {
    if (!isAllowedOrigin(origin, req.headers.host)) {
      done(false, 403, "WebSocket origin is not allowed");
      return;
    }
    done(true);
  }
});
wss.on("connection", (ws: WebSocket, request) => {
  if (wss.clients.size > MAX_CONNECTIONS) {
    ws.close(1013, "Server is at connection capacity");
    return;
  }
  console.log("Client connected");

  ws.on("message", (message) => {
    if (messageRateService.isRateLimited(ws)) {
      ws.close(1008, "Too many messages");
      return;
    }
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
        if (e instanceof Error) {
          console.error('register pairKey failed', e);
          sendMsg(ws, 'PENDING_PAIR_FAIL', { error: e.message });
        }
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
        sendMsg(targetWs, 'PAIR_SUCC', { roomKey });
        sendMsg(ws, 'PAIR_SUCC', { roomKey });
      } catch (e) {
        if (e instanceof Error) {
          console.error('register pairKey failed', e);
          sendMsg(ws, 'PAIR_FAIL', { error: e.message });
        }
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
        if (e instanceof Error) {
          console.error('join room error', e);
          sendMsg(ws, 'JOIN_ROOM_FAIL', { error: e.message });
        }
      }
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
  });

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

function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) {
    return false;
  }
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host;
  } catch (e) {
    console.error(e);
    return false;
  }
}
