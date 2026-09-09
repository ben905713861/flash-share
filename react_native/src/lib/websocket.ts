const WS_HOST = process.env.EXPO_PUBLIC_WS_URL?.replace(/\/$/, "");

if (!WS_HOST) {
    throw new Error("EXPO_PUBLIC_WS_URL is not configured");
}

type WebSocketOptions = {
    type: "pair" | "room";
    attachData: Record<string, string | undefined>,
    onConnecting?: () => void;
    onOpen?: () => void;
    onClose?: (event: CloseEvent) => boolean;
    onMessage: (type: string, data: any) => void;
};

export const createWebSocket = ({
                                    type,
                                    attachData,
                                    onConnecting,
                                    onClose,
                                    onOpen,
                                    onMessage }: WebSocketOptions) => {
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
        onConnecting?.();
        let queryParameterString: string = "?";
        for (const key in attachData) {
            const value = attachData[key];
            if (value) {
                queryParameterString += encodeURI(key) + "=" + encodeURI(value) + "&";
            }
        }
        queryParameterString = queryParameterString.substring(0, queryParameterString.length - 1);

        const socket = new WebSocket(`${WS_HOST}/${type}${queryParameterString}`);
        ws = socket;
        socket.onopen = () => {
            clearReconnectTimer();
            onOpen?.();
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
        socket.onclose = (event: CloseEvent) => {
            if (ws === socket) {
                ws = null;
            }
            const skip = onClose?.(event) ?? false;
            if (skip) {
                return;
            }
            scheduleReconnect();
        };
    };

    const send = (type: string, data: unknown = {}): boolean => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type, data }));
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
