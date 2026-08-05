const WS_HOST = "/ws";

type WebSocketOptions = {
    onConnecting: () => void;
    onOpen: () => void;
    onMessage: (type: string, data: any) => void;
};

export const createWebSocket = ({ onConnecting, onOpen, onMessage }: WebSocketOptions) => {
    let ws: WebSocket | null = null;
    let wsReconnectTimer: number | undefined;
    let disposed = false;

    const clearReconnectTimer = () => {
        if (wsReconnectTimer !== undefined) {
            window.clearTimeout(wsReconnectTimer);
            wsReconnectTimer = undefined;
        }
    };

    const scheduleReconnect = () => {
        if (disposed || wsReconnectTimer !== undefined) {
            return;
        }
        wsReconnectTimer = window.setTimeout(() => {
            wsReconnectTimer = undefined;
            init();
        }, 5000);
    };

    const init = () => {
        if (disposed || ws?.readyState === WebSocket.OPEN
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
            const { type, data } = JSON.parse(event.data);
            onMessage(type, data);
        };
        socket.onerror = () => socket.close();
        socket.onclose = () => {
            if (ws === socket) {
                ws = null;
            }
            scheduleReconnect();
        };
    };
    const send = (type: string, data: unknown = {}) => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, data, roomKey: localStorage.getItem("roomKey") }));
        }
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
