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

    const init = () => {
        if (disposed || ws?.readyState === WebSocket.OPEN) {
            return;
        }
        onConnecting();
        ws = new WebSocket(WS_HOST);
        ws.onopen = onOpen;
        ws.onmessage = (event) => {
            const { type, data } = JSON.parse(event.data);
            onMessage(type, data);
        };
        ws.onerror = () => ws?.close();
        ws.onclose = () => {
            if (!disposed) {
                wsReconnectTimer = window.setTimeout(init, 5000);
            }
        };
    };
    const send = (type: string, data: unknown = {}) => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, data, roomKey: localStorage.getItem("roomKey") }));
        }
    };
    const restart = () => {
        if (ws) {
            ws.onclose = init;
            ws.close();
            ws = null;
        }
    };
    const dispose = () => {
        disposed = true;
        window.clearTimeout(wsReconnectTimer);
        ws?.close();
    };

    init();
    return { send, restart, dispose };
};
