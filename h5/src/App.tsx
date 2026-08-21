import { ChangeEvent, useEffect, useRef, useState } from "react";
import QRCode from "@/components/qr-code";
import { createWebSocket } from "@/lib/websocket";
import {
    ConnectionStatus,
    FileDetail,
    FileTransferProgress,
    FileTransferStatus,
    createWebRTC,
} from "@/lib/webrtc";
import storage from "@/components/storage";
import { ThemeSwitcher } from "@/components/theme-switcher";

const formatBytes = (bytes: number) => {
    if (bytes === 0) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const makePairKey = () => {
    return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
}

const hasDuplicateFilenames = (files: File[]) => {
    const names = new Set<string>();
    for (const file of files) {
        if (names.has(file.name)) {
            return true;
        }
        names.add(file.name);
    }
    return false;
};

const transferStatusLabel: Record<FileTransferStatus, string> = {
    awaiting_approval: "Awaiting approval",
    queued: "Queued",
    transferring: "Transferring",
    completed: "Completed",
    declined: "Declined",
    failed: "Failed",
};

export function App() {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [page, setPage] = useState("pairPage");
    const [connectionSession, setConnectionSession] = useState(0);

    const [pairKey, setPairKey] = useState("");
    const [targetPairKey, setTargetPairKey] = useState("");
    const [userText, setUserText] = useState("");

    const [activeTab, setActiveTab] = useState<"message" | "files">("message");
    const [peerConnectionState, setPeerConnectionState] = useState<RTCIceConnectionState>("new");
    const [heartbeatLatency, setHeartbeatLatency] = useState<number | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSendingFile, setIsSendingFile] = useState(false);
    const [fileTransferProgress, setFileTransferProgress] = useState<FileTransferProgress[]>([]);
    // functions: sendText, sendFile, acceptFile, rejectFile, pair
    const sendTextRef = useRef<(text: string) => void>(() => {});
    const sendFileRef = useRef<(files: File[]) => void>(() => {});
    const acceptFileRef = useRef<() => Promise<void>>(async () => {});
    const rejectFileRef = useRef<() => void>(() => {});
    const disconnectRef = useRef<() => void>(() => {});
    const exitSignalRef = useRef<() => void>(() => {});
    const pairRef = useRef<(targetKey: string) => void>(() => {});

    useEffect(() => {
        const handleSignal = async (type: string, data: any) => {
            if (type === "PENDING_PAIR_SUCC") {
                setPage("pairPage");
                updateStatus("ready", "Share your code to pair a device");
            } else if (type === "PENDING_PAIR_FAIL" || type === "PAIR_FAIL" || type === "JOIN_ROOM_FAIL") {
                clearConnHistory();
                setPage("pairPage");
            } else if (type === "PAIR_SUCC") {
                storage.set("roomKey", data.roomKey);
                sendSignal("JOIN_ROOM");
                setPage("connectingPage");
                updateStatus("waiting", "Pairing complete. Establishing connection");
            } else if (type === "JOIN_ROOM_WAIT") {
                setPage("joinRoomWaitPage");
                updateStatus("waiting", "Waiting for the paired device");
            } else if (type === "JOIN_ROOM_SUCC") {
                setPage("connectingPage");
                await webRTC.createOffer(data);
            } else if (type === "SDP") {
                await webRTC.sdp(data);
            } else if (type === "SDP_ANSWER") {
                await webRTC.sdpAnswer(data);
            } else if (type === "ICE") {
                await webRTC.iceSwap(data);
            } else if (type === "EXIT") {
                restartSession();
            }
        };

        const sendSignal = (type: string, data: unknown = {}) => {
            webSocket.send(type, data);
        };

        const addActivity = (_entry: string) => undefined;

        const updateStatus = (next: ConnectionStatus, text: string) => {
            console.log(next, text);
        };

        const prepareJoinRoom = () => {
            const roomKey = storage.get("roomKey");
            if (roomKey) {
                sendSignal("JOIN_ROOM");
            } else {
                const key = makePairKey();
                setPairKey(key);
                sendSignal("PENDING_PAIR", { pairKey: key });
            }
        };

        const clearConnHistory = () => {
            setTargetPairKey("");
            storage.remove("roomKey");
            setPage("pairPage");
            const freshKey = makePairKey();
            setPairKey(freshKey);
            sendSignal("PENDING_PAIR", { pairKey: freshKey });
            updateStatus("ready", "Ready to pair with another device");
        };

        const fileRequestComes = (fileDetails: FileDetail[]) => {
            setIncomingFiles(fileDetails);
            setReceiveDialogOpen(true);
        };

        const initFileProgress = (fileDetails: FileDetail[]) => {
            const fileProgressList: FileTransferProgress[] = fileDetails.map(fileDetail => {
                return {
                    ...fileDetail,
                    transferred: -1,
                    status: "awaiting_approval",
                };
            });
            setFileTransferProgress(fileProgressList);
        };

        const updateFileTransferProgress = (filename: string, transferred: number, status?: FileTransferStatus) => {
            setFileTransferProgress((fileProgressList) => {
                return fileProgressList.map(fileProgress => {
                    if (fileProgress.filename === filename) {
                        if (status) {
                            if (transferred < 0) {
                                return { ...fileProgress, status };
                            }
                            return { ...fileProgress, transferred, status };
                        }
                        if (transferred >= fileProgress.size) {
                            status = "completed";
                        } else {
                            status = "transferring";
                        }
                        return {
                            ...fileProgress,
                            status,
                            transferred: Math.min(transferred, fileProgress.size),
                        };
                    }
                    return fileProgress;
                });
            });
        };

        const updateFileTransferStatus = (status: FileTransferStatus) => {
            setFileTransferProgress((fileProgressList) => {
                return fileProgressList.map(fileProgress => {
                    if (fileProgress.status === "completed") {
                        return fileProgress;
                    }
                    return { ...fileProgress, status };
                });
            });
        };

        const webSocket: ReturnType<typeof createWebSocket> = createWebSocket({
            onConnecting: () => updateStatus("connecting", "Connecting to signaling server"),
            onOpen: () => prepareJoinRoom(),
            onMessage: (type, data) => void handleSignal(type, data),
        });

        const webRTC: ReturnType<typeof createWebRTC> = createWebRTC({
            sendSignal,
            onRestartPeerConnection: () => webSocket.restart(),
            updateStatus,
            onPeerConnectionState: (nextState) => {
                if (nextState === "connected" || nextState === "completed") {
                    setPage("workPage");
                }
                setPeerConnectionState(nextState);
            },
            onHeartbeat: setHeartbeatLatency,
            addActivity,
            setUserText,
            fileRequestComes,
            setIsSendingFile,
            clearSelectedFiles,
            initFileProgress,
            updateFileTransferProgress,
            updateFileTransferStatus,
        });

        sendTextRef.current = webRTC.sendText;
        sendFileRef.current = webRTC.sendFile;
        exitSignalRef.current = () => sendSignal("EXIT");
        disconnectRef.current = () => {
            webRTC.dispose();
            webSocket.dispose();
        };
        acceptFileRef.current = async () => {
            setReceiveDialogOpen(false);
            await webRTC.acceptFile();
        };
        rejectFileRef.current = () => {
            setReceiveDialogOpen(false);
            webRTC.rejectFile();
        };
        pairRef.current = (targetKey) => {
            if (!targetKey.trim()) {
                updateStatus("error", "Enter the other device's pairing code");
                return;
            }
            sendSignal("PAIR", { targetPairKey: targetKey.trim() });
            updateStatus("waiting", "Requesting a secure pairing");
        }

        return () => {
            disconnectRef.current();
        };
    }, [connectionSession]); // empty array: only execute 1 time when load the page

    const onFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
        if (isSendingFile) {
            return;
        }
        const files = Array.from(event.target.files ?? []);
        if (hasDuplicateFilenames(files)) {
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
            setSelectedFiles([]);
            alert("Files with duplicate names cannot be selected together.");
            return;
        }
        setSelectedFiles(files);
    };

    const clearSelectedFiles = () => {
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
        setSelectedFiles([]);
    };

    const exitShare = () => {
        // Send before closing the socket so the paired device can leave too.
        const roomKey = storage.get("roomKey");
        if (roomKey) {
            // The signaling client attaches the current room key to every message.
            exitSignalRef.current();
        }
        restartSession();
    };

    const restartSession = () => {
        storage.remove("roomKey");
        setPage("pairPage");
        setConnectionSession((current) => current + 1);
    };

    const renderTransferList = () => {
        const title = selectedFiles.length > 0 ? "Sending files" : "Receiving files";
        if (fileTransferProgress.length === 0) {
            return (
                <></>
            );
        }
        return (
            <section className="transfer-task" aria-label={`${title} file transfer`}>
                <h4>{title}</h4>
                <ul className="transfer-file-list">
                    {fileTransferProgress.map((file) => {
                        const percent = file.size === 0 ? 100 : Math.round((file.transferred / file.size) * 100);
                        return (
                            <li key={file.filename}>
                                <div className="transfer-file-summary">
                                    <span title={file.filename}>{file.filename}</span>
                                    <small>{formatBytes(file.size)}</small>
                                    <strong className={`transfer-status ${file.status}`}>
                                        {transferStatusLabel[file.status]}
                                    </strong>
                                </div>
                                {(file.status === "transferring" || file.status === "completed") && (
                                    <>
                                        <progress value={file.transferred} max={Math.max(file.size, 1)} />
                                        <small className="transfer-bytes">
                                            {`${formatBytes(file.transferred)} of ${formatBytes(file.size)} (${percent}%)`}
                                        </small>
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </section>
        );
    };

    const scanPairCode = async () => {
        const Detector = (window as any).BarcodeDetector;
        if (!Detector) {
            alert("Camera scanning is not supported in this browser. Enter the pairing code manually.");
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
            const video = document.createElement("video");
            video.srcObject = stream;
            await video.play();
            const detector = new Detector({ formats: ["qr_code"] });
            const codes = await detector.detect(video);
            stream.getTracks().forEach((track) => track.stop());
            if (codes[0]?.rawValue) {
                setTargetPairKey(codes[0].rawValue);
                pairRef.current(codes[0].rawValue);
            }
        } catch {
            alert("Unable to access the camera. Enter the pairing code manually.");
        }
    };

    const renderConnectedWorkspace = () => (
        <section className="connected-workspace" aria-label="Shared workspace">
            <nav className="workspace-tabs" aria-label="Transfer modes">
                <button className={activeTab === "message" ? "tab active" : "tab"} onClick={() => setActiveTab("message")} type="button">Text</button>
                <button className={activeTab === "files" ? "tab active" : "tab"} onClick={() => setActiveTab("files")} type="button">File</button>
            </nav>
                {activeTab === "message" ?
                    <div className="tool-block message-block minimal-tool-block">
                        <textarea
                            value={userText}
                            onChange={(event) => {
                                setUserText(event.target.value);
                            }}
                            placeholder="Write a note for the other device..."
                        />
                        <div className="tool-footer">
                            <span>{userText.length} characters</span>
                            <button
                                className="primary-button"
                                type="button"
                                disabled={!userText.trim()}
                                onClick={() => sendTextRef.current(userText)}
                            >
                                Send message
                            </button>
                        </div>
                    </div>
                    :
                    <div className="tool-block file-block minimal-tool-block">
                        <label className="drop-zone" htmlFor="files">
                            <input
                                id="files"
                                ref={fileInputRef}
                                type="file"
                                multiple
                                disabled={isSendingFile}
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
                        {renderTransferList()}
                        <div className="tool-footer">
                            <span>
                                {selectedFiles.length
                                    ? `${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))} ready`
                                    : "No files selected"}
                            </span>
                            <button
                                className="primary-button"
                                type="button"
                                disabled={!selectedFiles.length || isSendingFile}
                                onClick={() => sendFileRef.current(selectedFiles)}
                            >
                                {isSendingFile ? "Awaiting approval" : "Send files"}
                            </button>
                        </div>
                    </div>}
        </section>
    );

    return (
        <main className="app-shell">
            <header className="topbar">
                <a className="brand" aria-label="Flash Share home">
                    <span className="brand-mark">F</span>
                </a>
                <div className="topbar-actions">
                    <div className="network-stats" aria-label="Connection diagnostics">
                        <span>{peerConnectionState}</span>
                        <span>{heartbeatLatency === null ? "--" : `${heartbeatLatency} ms`}</span>
                    </div>
                    <ThemeSwitcher />
                    {page !== "pairPage" && (
                    <button className="exit-button secondary-button" type="button" onClick={exitShare} title="Exit and disconnect" aria-label="Exit and disconnect">
                        <span aria-hidden="true">❌</span>
                    </button>
                    )}
                </div>
            </header>

            {page === "pairPage" &&
                <section className="pair-screen" aria-label="Pair devices">
                    <div className="pair-card">
                        <h1>Pair a device</h1>
                        <p className="muted">Scan the QR code or enter this pairing code on other device.</p>
                        {pairKey && (
                            <div className="qr-frame"><QRCode value={pairKey} size={204} /></div>
                        )}
                        <div className="your-code"><span>Pairing code</span><strong>{pairKey || "Preparing..."}</strong><button className="icon-button" type="button" title="Copy pairing code" onClick={() => navigator.clipboard?.writeText(pairKey)}>Copy</button></div>
                        <label className="field-label" htmlFor="target-key">Enter the other device's code</label>
                        <div className="join-row"><input id="target-key" placeholder="Pairing code" value={targetPairKey} onChange={(event) => setTargetPairKey(event.target.value)} /><button className="camera-button" type="button" title="Scan QR code" onClick={() => void scanPairCode()}>📷</button><button className="primary-button" type="button" onClick={() => pairRef.current(targetPairKey)}>Pair</button></div>
                    </div>
                </section>
            }
            {page === "joinRoomWaitPage" &&
                <section className="waiting-screen" aria-label="Waiting for paired device">
                    <div className="waiting-card">
                        <div className="waiting-indicator" aria-hidden="true"><span /></div>
                        <div className="eyebrow">Room ready</div>
                        <h1>Waiting for the other device</h1>
                        <p>Your device has joined the room. Keep this page open while the paired device connects.</p>
                        {pairKey && (
                            <div className="waiting-code">
                                <span>Pairing code</span><strong>{pairKey}</strong>
                            </div>
                        )}
                    </div>
                </section>
            }
            {page === "connectingPage" &&
                <section className="waiting-screen" aria-label="Establishing connection">
                    <div className="waiting-card">
                        <div className="waiting-indicator" aria-hidden="true"><span /></div>
                        <div className="eyebrow">Pairing complete</div>
                        <h1>Establishing a secure connection</h1>
                        <p>Your devices are negotiating a direct connection. Keep this page open.</p>
                    </div>
                </section>
            }
            {page === "workPage" && renderConnectedWorkspace()}

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
                            {incomingFiles.length <= 1 ? "" : "s"}.
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
                                onClick={() => rejectFileRef.current()}
                            >
                                Decline
                            </button>
                            <button
                                className="primary-button"
                                type="button"
                                onClick={() => void acceptFileRef.current()}
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
