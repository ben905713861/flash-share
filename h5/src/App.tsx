import { ChangeEvent, useEffect, useRef, useState } from "react";

const WS_HOST = "/ws";
const FILE_CHUNK_SIZE = 64 * 1024;
const FILE_CHUNK_WINDOW = 16;
const FILE_BUFFER_HIGH_WATER_MARK = 4 * 1024 * 1024;
const FILE_BUFFER_LOW_WATER_MARK = 1 * 1024 * 1024;

type ConnectionStatus = "connecting" | "ready" | "waiting" | "connected" | "error";
type FileDetail = { filename: string; size: number };
type Controls = {
    pair: () => void;
    sendText: () => void;
    sendFiles: () => void;
    acceptFiles: () => Promise<void>;
    rejectFiles: () => void;
};

const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const makePairKey = () => crypto.randomUUID?.() ?? Math.random().toString(16).slice(2);

export function App() {
    const [pairKey, setPairKey] = useState("");
    const [targetPairKey, setTargetPairKey] = useState("");
    const [message, setMessage] = useState("");
    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [statusText, setStatusText] = useState("Connecting to signaling server");
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [activity, setActivity] = useState<string[]>(["Preparing secure connection"]);
    const targetKeyRef = useRef("");
    const messageRef = useRef("");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const selectedFilesRef = useRef<File[]>([]);
    const controlsRef = useRef<Controls | null>(null);

    useEffect(() => {
        let peer: RTCPeerConnection | null = null;
        let dataChannel: RTCDataChannel | null = null;
        let fileChannel: RTCDataChannel | null = null;
        let heartbeatChannel: RTCDataChannel | null = null;
        let ws: WebSocket | null = null;
        let heartbeatTimer: number | undefined;
        let disconnectTimer: number | undefined;
        let reconnectTimer: number | undefined;
        let disposed = false;
        let canAddIceCandidate = false;
        let lastPingAt = Date.now();
        let lastPongAt = Date.now();
        let isSendingFile = false;
        let isInterrupted = false;
        const iceBuffer: RTCIceCandidate[] = [];
        let sendingFiles: File[] = [];
        let wakeupSending: (() => void) | undefined;
        let interruptSending: (() => void) | undefined;
        let directoryHandle: FileSystemDirectoryHandle | undefined;
        let currentWritable: FileSystemWritableFileStream | undefined;
        let currentFileHandle: FileSystemFileHandle | undefined;
        let receivedChunkCount = 0;

        const addActivity = (entry: string) => setActivity((items) => [entry, ...items].slice(0, 4));
        const updateStatus = (next: ConnectionStatus, text: string) => {
            setStatus(next);
            setStatusText(text);
        };
        const sendSignal = (type: string, data: unknown = {}) => {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type, data, roomKey: localStorage.getItem("roomKey") }));
            }
        };
        const sendFileControl = (content: unknown) => {
            if (fileChannel?.readyState === "open") fileChannel.send(JSON.stringify(content));
        };
        const resetConnection = () => {
            setTargetPairKey("");
            targetKeyRef.current = "";
            localStorage.clear();
            const freshKey = makePairKey();
            setPairKey(freshKey);
            sendSignal("PENDING_PAIR", { pairKey: freshKey });
            updateStatus("ready", "Ready to pair with another device");
        };
        const addBufferedIce = async () => {
            while (iceBuffer.length && peer) await peer.addIceCandidate(iceBuffer.shift()!);
            canAddIceCandidate = true;
        };
        const startHeartbeat = () => {
            if (heartbeatTimer) return;
            heartbeatTimer = window.setInterval(() => {
                if (heartbeatChannel?.readyState === "open") {
                    lastPingAt = Date.now();
                    heartbeatChannel.send(`ping:${lastPingAt}`);
                }
            }, 5000);
        };
        const waitForDrain = (channel: RTCDataChannel) => {
            if (channel.readyState !== "open") return Promise.reject(new Error("File channel closed"));
            if (channel.bufferedAmount <= FILE_BUFFER_LOW_WATER_MARK) return Promise.resolve();
            return new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    channel.removeEventListener("bufferedamountlow", onLow);
                    channel.removeEventListener("close", onClose);
                    channel.removeEventListener("error", onError);
                };
                const onLow = () => {
                    cleanup();
                    resolve();
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error("File channel closed"));
                };
                const onError = () => {
                    cleanup();
                    reject(new Error("File channel failed"));
                };
                channel.addEventListener("bufferedamountlow", onLow, { once: true });
                channel.addEventListener("close", onClose, { once: true });
                channel.addEventListener("error", onError, { once: true });
            });
        };
        const sendSingleFile = async (file: File) => {
            isInterrupted = false;
            interruptSending = () => {
                isInterrupted = true;
            };
            for (let offset = 0, chunkIndex = 0; offset < file.size; offset += FILE_CHUNK_SIZE) {
                if (fileChannel?.readyState !== "open") throw new Error("File channel closed");
                if (isInterrupted) throw new Error("File transfer aborted");
                if (fileChannel.bufferedAmount >= FILE_BUFFER_HIGH_WATER_MARK)
                    await waitForDrain(fileChannel);
                fileChannel.send(await file.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer());
                chunkIndex += 1;
                if (chunkIndex % FILE_CHUNK_WINDOW === 0) {
                    await new Promise<void>((resolve, reject) => {
                        wakeupSending = resolve;
                        interruptSending = () => {
                            isInterrupted = true;
                            reject(new Error("File transfer aborted"));
                        };
                    });
                }
            }
        };
        const initDataChannel = () => {
            if (!dataChannel) return;
            dataChannel.onopen = () => addActivity("Message channel connected");
            dataChannel.onmessage = (event) => {
                setMessage(event.data);
                messageRef.current = event.data;
                addActivity("Message received from paired device");
            };
            dataChannel.onclose = () => addActivity("Message channel closed");
        };
        const initFileChannel = () => {
            if (!fileChannel) return;
            const channel = fileChannel;
            channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_MARK;
            channel.binaryType = "arraybuffer";
            channel.onopen = () => addActivity("File channel connected");
            channel.onmessage = async (event) => {
                if (typeof event.data === "string") {
                    const payload = JSON.parse(event.data);
                    const { type, fileDetails, filename, size } = payload;
                    if (type === "file-request") {
                        setIncomingFiles(fileDetails);
                        setReceiveDialogOpen(true);
                        addActivity(
                            `${fileDetails.length} incoming file${fileDetails.length === 1 ? "" : "s"} awaiting approval`,
                        );
                    } else if (type === "file-request-ack") {
                        const file = sendingFiles[0];
                        if (file)
                            sendFileControl({ type: "file-start", filename: file.name, size: file.size });
                    } else if (type === "file-request-reject") {
                        isSendingFile = false;
                        setIsSending(false);
                        addActivity("File request declined by the other device");
                    } else if (type === "file-start") {
                        try {
                            currentFileHandle = await directoryHandle?.getFileHandle(filename, {
                                create: true,
                            });
                            currentWritable = await currentFileHandle?.createWritable();
                            if (!currentWritable) throw new Error("No destination folder selected");
                            receivedChunkCount = 0;
                            sendFileControl({ type: "file-start-ack", filename });
                        } catch {
                            sendFileControl({ type: "file-start-reject", filename });
                        }
                    } else if (type === "file-start-ack") {
                        const file = sendingFiles.find((item) => item.name === filename);
                        if (!file) return;
                        try {
                            addActivity(`Sending ${file.name}`);
                            await sendSingleFile(file);
                            sendFileControl({ type: "file-end", filename: file.name, size: file.size });
                        } catch {
                            sendingFiles = [];
                            isSendingFile = false;
                            setIsSending(false);
                            sendFileControl({ type: "file-send-error", filename });
                        }
                    } else if (type === "file-continue") {
                        wakeupSending?.();
                    } else if (type === "file-abort") {
                        interruptSending?.();
                    } else if (type === "file-end") {
                        try {
                            await currentWritable?.close();
                            const received = await currentFileHandle?.getFile();
                            currentWritable = undefined;
                            if (received?.size === size) {
                                sendFileControl({ type: "file-end-ack", filename });
                                addActivity(`Received ${filename}`);
                            } else sendFileControl({ type: "file-end-reject" });
                        } catch {
                            sendFileControl({ type: "file-end-reject" });
                        }
                    } else if (type === "file-end-ack") {
                        sendingFiles = sendingFiles.filter((item) => item.name !== filename);
                        if (!sendingFiles.length) {
                            isSendingFile = false;
                            setIsSending(false);
                            setSelectedFiles([]);
                            selectedFilesRef.current = [];
                            if (fileInputRef.current) fileInputRef.current.value = "";
                            addActivity("File transfer completed");
                        } else {
                            const file = sendingFiles[0];
                            sendFileControl({ type: "file-start", filename: file.name, size: file.size });
                        }
                    } else if (
                        type === "file-send-error" ||
                        type === "file-end-reject" ||
                        type === "file-start-reject"
                    ) {
                        sendingFiles = [];
                        isSendingFile = false;
                        setIsSending(false);
                    }
                    return;
                }
                if (event.data instanceof ArrayBuffer && currentWritable) {
                    try {
                        await currentWritable.write(event.data);
                        receivedChunkCount += 1;
                        if (receivedChunkCount % FILE_CHUNK_WINDOW === 0)
                            sendFileControl({ type: "file-continue" });
                    } catch {
                        sendFileControl({ type: "file-abort" });
                        await currentWritable.abort();
                        currentWritable = undefined;
                    }
                }
            };
            channel.onclose = () => {
                interruptSending?.();
                isSendingFile = false;
                setIsSending(false);
            };
        };
        const initHeartbeatChannel = () => {
            if (!heartbeatChannel) return;
            heartbeatChannel.onopen = startHeartbeat;
            heartbeatChannel.onmessage = (event) => {
                if (event.data.startsWith("ping:"))
                    heartbeatChannel?.send(event.data.replace("ping:", "pong:"));
                if (event.data.startsWith("pong:")) lastPongAt = Date.now();
            };
        };
        const restartPeer = () => {
            window.clearTimeout(disconnectTimer);
            window.clearInterval(heartbeatTimer);
            dataChannel?.close();
            fileChannel?.close();
            heartbeatChannel?.close();
            peer?.close();
            dataChannel = fileChannel = heartbeatChannel = null;
            peer = null;
            canAddIceCandidate = false;
            iceBuffer.length = 0;
            initPeer();
        };
        const initPeer = () => {
            peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
            peer.onicecandidate = (event) => {
                if (event.candidate) sendSignal("ICE", event.candidate);
            };
            peer.ondatachannel = (event) => {
                if (event.channel.label === "chat") {
                    dataChannel = event.channel;
                    initDataChannel();
                }
                if (event.channel.label === "file") {
                    fileChannel = event.channel;
                    initFileChannel();
                }
                if (event.channel.label === "heartbeat") {
                    heartbeatChannel = event.channel;
                    initHeartbeatChannel();
                }
            };
            peer.oniceconnectionstatechange = () => {
                if (!peer) return;
                if (["connected", "completed"].includes(peer.iceConnectionState)) {
                    window.clearTimeout(disconnectTimer);
                    updateStatus("connected", "Secure peer-to-peer connection active");
                    addActivity("Devices connected directly");
                } else if (peer.iceConnectionState === "disconnected") {
                    disconnectTimer = window.setTimeout(() => {
                        if (
                            peer?.iceConnectionState === "disconnected" ||
                            peer?.iceConnectionState === "failed"
                        ) {
                            restartPeer();
                            restartWs();
                        }
                    }, 60000);
                } else if (peer.iceConnectionState === "failed") {
                    restartPeer();
                    restartWs();
                }
            };
        };
        const createOffer = async () => {
            if (!peer) return;
            if (dataChannel || fileChannel || heartbeatChannel) restartPeer();
            dataChannel = peer!.createDataChannel("chat");
            initDataChannel();
            fileChannel = peer!.createDataChannel("file");
            initFileChannel();
            heartbeatChannel = peer!.createDataChannel("heartbeat");
            initHeartbeatChannel();
            try {
                await peer!.setLocalDescription(await peer!.createOffer());
                sendSignal("SDP", peer!.localDescription);
            } catch {
                updateStatus("error", "Unable to create a peer connection");
            }
        };
        const handleSignal = async (type: string, data: any) => {
            if (type === "PENDING_PAIR_SUCC") {
                updateStatus("ready", "Share your code to pair a device");
                addActivity("Pairing code registered");
            } else if (type === "PENDING_PAIR_FAIL" || type === "PAIR_FAIL" || type === "JOIN_ROOM_FAIL") {
                resetConnection();
                addActivity("Pairing failed. A new code is ready.");
            } else if (type === "PAIR_SUCC") {
                localStorage.setItem("roomKey", data.roomKey);
                updateStatus("waiting", "Pairing complete. Establishing connection");
                sendSignal("JOIN_ROOM");
            } else if (type === "JOIN_ROOM_WAIT") {
                updateStatus("waiting", "Waiting for the paired device");
            } else if (type === "JOIN_ROOM_SUCC" && data.isOfferer) await createOffer();
            else if (type === "SDP" && peer) {
                try {
                    await peer.setRemoteDescription(new RTCSessionDescription(data));
                    await addBufferedIce();
                    await peer.setLocalDescription(await peer.createAnswer());
                    sendSignal("SDP_ANSWER", peer.localDescription);
                } catch {
                    updateStatus("error", "Unable to establish peer connection");
                }
            } else if (type === "SDP_ANSWER" && peer) {
                await peer.setRemoteDescription(new RTCSessionDescription(data));
                await addBufferedIce();
            } else if (type === "ICE") {
                const candidate = new RTCIceCandidate(data);
                if (canAddIceCandidate) await peer?.addIceCandidate(candidate);
                else iceBuffer.push(candidate);
            }
        };
        const prepareJoin = () => {
            const roomKey = localStorage.getItem("roomKey");
            if (roomKey) sendSignal("JOIN_ROOM");
            else {
                const key = makePairKey();
                setPairKey(key);
                sendSignal("PENDING_PAIR", { pairKey: key });
            }
        };
        const initWs = () => {
            if (disposed || ws?.readyState === WebSocket.OPEN) return;
            updateStatus("connecting", "Connecting to signaling server");
            ws = new WebSocket(WS_HOST);
            ws.onopen = prepareJoin;
            ws.onmessage = (event) => {
                const { type, data } = JSON.parse(event.data);
                void handleSignal(type, data);
            };
            ws.onerror = () => ws?.close();
            ws.onclose = () => {
                if (!disposed) reconnectTimer = window.setTimeout(initWs, 5000);
            };
        };
        const restartWs = () => {
            if (ws) {
                ws.onclose = initWs;
                ws.close();
                ws = null;
            }
        };
        controlsRef.current = {
            pair: () => {
                if (!targetKeyRef.current.trim()) {
                    updateStatus("error", "Enter the other device's pairing code");
                    return;
                }
                sendSignal("PAIR", { targetPairKey: targetKeyRef.current.trim() });
                updateStatus("waiting", "Requesting a secure pairing");
            },
            sendText: () => {
                if (dataChannel?.readyState !== "open") {
                    updateStatus("error", "Connect a device before sending a message");
                    return;
                }
                if (!messageRef.current.trim()) return;
                dataChannel.send(messageRef.current);
                addActivity("Message sent");
            },
            sendFiles: () => {
                if (fileChannel?.readyState !== "open") {
                    updateStatus("error", "Connect a device before sending files");
                    return;
                }
                if (!selectedFilesRef.current.length || isSendingFile) return;
                isSendingFile = true;
                sendingFiles = [...selectedFilesRef.current];
                setIsSending(true);
                sendFileControl({
                    type: "file-request",
                    fileDetails: sendingFiles.map((file) => ({ filename: file.name, size: file.size })),
                });
                addActivity("Waiting for the other device to approve file transfer");
            },
            acceptFiles: async () => {
                setReceiveDialogOpen(false);
                if (!window.showDirectoryPicker) {
                    addActivity("This browser cannot choose a download folder");
                    sendFileControl({ type: "file-request-reject" });
                    return;
                }
                try {
                    directoryHandle = await window.showDirectoryPicker();
                    sendFileControl({ type: "file-request-ack" });
                } catch {
                    sendFileControl({ type: "file-request-reject" });
                }
            },
            rejectFiles: () => {
                setReceiveDialogOpen(false);
                sendFileControl({ type: "file-request-reject" });
            },
        };
        initPeer();
        initWs();
        return () => {
            disposed = true;
            window.clearTimeout(reconnectTimer);
            window.clearTimeout(disconnectTimer);
            window.clearInterval(heartbeatTimer);
            ws?.close();
            dataChannel?.close();
            fileChannel?.close();
            heartbeatChannel?.close();
            peer?.close();
        };
    }, []);

    const onFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        selectedFilesRef.current = files;
        setSelectedFiles(files);
    };
    const readyToSend = status === "connected";

    return (
        <main className="app-shell">
            <header className="topbar">
                <a className="brand" href="/" aria-label="Flash Share home">
                    <span className="brand-mark">F</span>Flash Share
                </a>
                <span className="topbar-note">Private browser-to-browser transfer</span>
            </header>
            <section className="workspace" aria-label="Flash Share workspace">
                <aside className="connection-panel">
                    <div className="eyebrow">Connection</div>
                    <h1>Send without the cloud.</h1>
                    <p className="muted">Pair two browsers, then exchange notes and files directly.</p>
                    <div className={`connection-state ${status}`}>
                        <span className="status-dot" />
                        <div>
                            <strong>
                                {status === "connected"
                                    ? "Connected"
                                    : status === "ready"
                                      ? "Ready to pair"
                                      : status === "waiting"
                                        ? "Pairing"
                                        : status === "error"
                                          ? "Action needed"
                                          : "Connecting"}
                            </strong>
                            <small>{statusText}</small>
                        </div>
                    </div>
                    <label className="field-label" htmlFor="pair-key">
                        Your pairing code
                    </label>
                    <div className="code-field">
                        <input id="pair-key" readOnly value={pairKey} />
                        <button
                            className="icon-button"
                            type="button"
                            title="Copy pairing code"
                            onClick={() => navigator.clipboard?.writeText(pairKey)}
                        >
                            Copy
                        </button>
                    </div>
                    <label className="field-label" htmlFor="target-key">
                        Other device's code
                    </label>
                    <div className="join-row">
                        <input
                            id="target-key"
                            placeholder="Paste pairing code"
                            value={targetPairKey}
                            onChange={(event) => {
                                setTargetPairKey(event.target.value);
                                targetKeyRef.current = event.target.value;
                            }}
                        />
                        <button
                            className="primary-button"
                            type="button"
                            onClick={() => controlsRef.current?.pair()}
                        >
                            Pair
                        </button>
                    </div>
                    <div className="activity">
                        <span>Recent activity</span>
                        {activity.map((entry, index) => (
                            <p key={`${entry}-${index}`}>{entry}</p>
                        ))}
                    </div>
                </aside>
                <section className="share-panel">
                    <div className="share-heading">
                        <div>
                            <div className="eyebrow">Shared space</div>
                            <h2>Drop in what matters.</h2>
                        </div>
                        <span className={`compact-status ${status}`}>
                            {readyToSend ? "Live" : "Not connected"}
                        </span>
                    </div>
                    <div className="tool-block message-block">
                        <div className="tool-title">
                            <h3>Quick message</h3>
                            <span>Delivered instantly</span>
                        </div>
                        <textarea
                            value={message}
                            onChange={(event) => {
                                setMessage(event.target.value);
                                messageRef.current = event.target.value;
                            }}
                            placeholder="Write a note for the other device..."
                        />
                        <div className="tool-footer">
                            <span>{message.length} characters</span>
                            <button
                                className="primary-button"
                                type="button"
                                disabled={!message.trim()}
                                onClick={() => controlsRef.current?.sendText()}
                            >
                                Send message
                            </button>
                        </div>
                    </div>
                    <div className="tool-block">
                        <div className="tool-title">
                            <h3>Files</h3>
                            <span>Direct, encrypted transfer</span>
                        </div>
                        <label className="drop-zone" htmlFor="files">
                            <input
                                id="files"
                                ref={fileInputRef}
                                type="file"
                                multiple
                                onChange={onFilesSelected}
                            />
                            <strong>
                                {selectedFiles.length
                                    ? `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected`
                                    : "Choose files to share"}
                            </strong>
                            <small>
                                {selectedFiles.length
                                    ? selectedFiles
                                          .map((file) => `${file.name} (${formatBytes(file.size)})`)
                                          .join(" · ")
                                    : "Any file type. The other device chooses where to save it."}
                            </small>
                        </label>
                        <div className="tool-footer">
                            <span>
                                {selectedFiles.length
                                    ? `${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))} ready`
                                    : "No files selected"}
                            </span>
                            <button
                                className="primary-button"
                                type="button"
                                disabled={!selectedFiles.length || isSending}
                                onClick={() => controlsRef.current?.sendFiles()}
                            >
                                {isSending ? "Awaiting approval" : "Send files"}
                            </button>
                        </div>
                    </div>
                </section>
            </section>
            {isReceiveDialogOpen && (
                <div className="modal-backdrop" role="presentation">
                    <section
                        className="receive-dialog"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="receive-title"
                    >
                        <div className="dialog-symbol">↓</div>
                        <h2 id="receive-title">Incoming files</h2>
                        <p>
                            The paired device wants to send {incomingFiles.length} file
                            {incomingFiles.length === 1 ? "" : "s"}.
                        </p>
                        <div className="incoming-list">
                            {incomingFiles.map((file) => (
                                <div key={file.filename}>
                                    <span>{file.filename}</span>
                                    <small>{formatBytes(file.size)}</small>
                                </div>
                            ))}
                        </div>
                        <div className="dialog-actions">
                            <button
                                className="secondary-button"
                                type="button"
                                onClick={() => controlsRef.current?.rejectFiles()}
                            >
                                Decline
                            </button>
                            <button
                                className="primary-button"
                                type="button"
                                onClick={() => void controlsRef.current?.acceptFiles()}
                            >
                                Choose folder & receive
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </main>
    );
}
