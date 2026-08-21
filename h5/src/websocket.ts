import storage from "./lib/storage";

const WS_HOST = "wss://local.wxb26.click:8011/ws";

type WebSocketOptions = {
    onConnecting: () => void;
    onOpen: () => void;
    onMessage: (type: string, data: any) => void;
};

export const createWebSocket = ({ onConnecting, onOpen, onMessage }: WebSocketOptions) => {
    let ws: WebSocket | null = null;
    let wsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const clearReconnectTimer = () => {
        if (wsReconnectTimer !== undefined) {
            globalThis.clearTimeout(wsReconnectTimer);
            wsReconnectTimer = undefined;
        }
    };

    const scheduleReconnect = () => {
        if (disposed || wsReconnectTimer !== undefined) {
            return;
        }
        wsReconnectTimer = globalThis.setTimeout(() => {
            wsReconnectTimer = undefined;
            init();
        }, 5000);
    };

    const init = () => {
        if (disposed
                || ws?.readyState === WebSocket.OPEN
                || ws?.readyState === WebSocket.CONNECTING
                || ws?.readyState === WebSocket.CLOSING) {
            return;
        }
        clearReconnectTimer();
        onConnecting();
        const socket = new WebSocket(WS_HOST);
        ws = socket;
        socket.onopen = () => {
            clearReconnectTimer();
            onOpen();
        };
        socket.onmessage = (event) => {
            let message: { type: string; data: unknown };
            try {
                message = JSON.parse(event.data) as { type: string; data: unknown };
            } catch (error) {
                console.warn("Ignoring malformed signaling message", error);
                return;
            }
            onMessage(message.type, message.data);
        };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
            if (ws === socket) {
                ws = null;
            }
            scheduleReconnect();
        };
    };

    const send = (type: string, data: unknown = {}): boolean => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, data, roomKey: storage.get("roomKey") }));
            return true;
        }
        console.warn(`Signaling message not sent because WebSocket is not open: ${type}`);
        return false;
    };

    const restart = () => {
        clearReconnectTimer();
        const socket = ws;
        ws = null;
        if (socket) {
            socket.onclose = null;
            socket.close();
        }
        init();
    };

    const dispose = () => {
        disposed = true;
        clearReconnectTimer();
        const socket = ws;
        ws = null;
        if (socket) {
            socket.onclose = null;
            socket.close();
        }
    };

    init();
    return { send, restart, dispose };
};
