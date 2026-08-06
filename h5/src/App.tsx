import { ChangeEvent, useEffect, useRef, useState } from "react";
import { createWebSocket } from "./websocket";
import {
    ConnectionStatus,
    FileDetail,
    FileTransferProgress,
    FileTransferStatus,
    createWebRTC,
} from "./webrtc";

const formatBytes = (bytes: number) => {
    if (bytes === 0) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const makePairKey = () => {
    return crypto.randomUUID?.() ?? Math.random().toString(16).slice(2);
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
    "awaiting_approval": "Awaiting approval",
    queued: "Queued",
    transferring: "Transferring",
    completed: "Completed",
    declined: "Declined",
    failed: "Failed",
};

type ThemePreference = "system" | "light" | "dark";

export function App() {
    const [pairKey, setPairKey] = useState("");
    const [targetPairKey, setTargetPairKey] = useState("");
    const [userText, setUserText] = useState("");

    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [statusText, setStatusText] = useState("Connecting to signaling server");
    const [activeTab, setActiveTab] = useState<"message" | "files">("message");
    const [peerConnectionState, setPeerConnectionState] = useState<RTCIceConnectionState>("new");
    const [heartbeatLatency, setHeartbeatLatency] = useState<number | null>(null);
    const [isWaitingForPeer, setWaitingForPeer] = useState(false);
    const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
        const saved = localStorage.getItem("flash-share-theme");
        return saved === "light" || saved === "dark" ? saved : "system";
    });
    const [systemDark, setSystemDark] = useState(false);

    useEffect(() => {
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const update = () => setSystemDark(media.matches);
        update();
        media.addEventListener?.("change", update);
        return () => media.removeEventListener?.("change", update);
    }, []);

    useEffect(() => {
        const resolved = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;
        document.documentElement.dataset.theme = resolved;
        if (themePreference === "system") {
            localStorage.removeItem("flash-share-theme");
        } else {
            localStorage.setItem("flash-share-theme", themePreference);
        }
    }, [themePreference, systemDark]);

    const resolvedTheme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;
    const toggleTheme = () => {
        setThemePreference((current) => {
            if (current === "system") return "light";
            if (current === "light") return "dark";
            return "system";
        });
    };
    const themeIcon = themePreference === "system" ? "◒" : themePreference === "light" ? "☀" : "🌙";
    const themeName = themePreference === "system" ? "Auto" : themePreference === "light" ? "Light" : "Dark";

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSendingFile, setIsSendingFile] = useState(false);
    const [fileTransferProgress, setFileTransferProgress] = useState<FileTransferProgress[]>([]);
    // functions: sendText, sendFile, acceptFile, rejectFile, pair
    const sendTextRef = useRef<(text: string) => void>(() => {});
    const sendFileRef = useRef<(files: File[]) => void>(() => {});
    const acceptFileRef = useRef<() => void>(() => {});
    const rejectFileRef = useRef<() => void>(() => {});
    const disconnectRef = useRef<() => void>(() => {});
    const exitSignalRef = useRef<() => void>(() => {});
    const pairRef = useRef<(targetKey: string) => void>(() => {});

    useEffect(() => {
        const handleSignal = async (type: string, data: any) => {
            if (type === "PENDING_PAIR_SUCC") {
                setWaitingForPeer(false);
                updateStatus("ready", "Share your code to pair a device");
            } else if (type === "EXIT") {
                localStorage.removeItem("roomKey");
                webRTC.dispose();
                webSocket.dispose();
                window.location.reload();
            } else if (type === "PENDING_PAIR_FAIL" || type === "PAIR_FAIL" || type === "JOIN_ROOM_FAIL") {
                setWaitingForPeer(false);
                clearConnHistory();
            } else if (type === "PAIR_SUCC") {
                localStorage.setItem("roomKey", data.roomKey);
                updateStatus("waiting", "Pairing complete. Establishing connection");
                sendSignal("JOIN_ROOM");
            } else if (type === "JOIN_ROOM_WAIT") {
                setWaitingForPeer(true);
                updateStatus("waiting", "Waiting for the paired device");
            } else if (type === "JOIN_ROOM_SUCC") {
                setWaitingForPeer(false);
                await webRTC.createOffer(data);
            } else if (type === "SDP") {
                await webRTC.sdp(data);
            } else if (type === "SDP_ANSWER") {
                await webRTC.sdpAnswer(data);
            } else if (type === "ICE") {
                await webRTC.iceSwap(data);
            }
        };

        const sendSignal = (type: string, data: unknown = {}) => {
            webSocket.send(type, data);
        }

        const addActivity = (_entry: string) => undefined;

        const updateStatus = (next: ConnectionStatus, text: string) => {
            setStatus(next);
            setStatusText(text);
        };

        const prepareJoinRoom = () => {
            const roomKey = localStorage.getItem("roomKey");
            if (roomKey) {
                sendSignal("JOIN_ROOM");
            } else {
                const key = makePairKey();
                setPairKey(key);
                sendSignal("PENDING_PAIR", { pairKey: key });
            }
        };

        const clearConnHistory = () => {
            setWaitingForPeer(false);
            setTargetPairKey("");
            localStorage.removeItem("roomKey");
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
            })
            setFileTransferProgress(fileProgressList);
        }

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
        }

        const updateFileTransferStatus = (status: FileTransferStatus) => {
            setFileTransferProgress((fileProgressList) => {
                return fileProgressList.map(fileProgress => {
                    if (fileProgress.status === "completed") {
                        return fileProgress;
                    }
                    return { ...fileProgress, status };
                });
            });
        }

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
                setPeerConnectionState(nextState);
                if (nextState === "connected" || nextState === "completed") {
                    setWaitingForPeer(false);
                }
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
    }, []); // empty array: only execute 1 time when load the page

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

    const peerStateLabel = peerConnectionState === "connected" || peerConnectionState === "completed" ? "Connected" : peerConnectionState === "checking" ? "Checking" : peerConnectionState === "disconnected" ? "Disconnected" : peerConnectionState === "failed" ? "Failed" : "Waiting";

    const exitShare = () => {
        // Send before closing the socket so the paired device can leave too.
        const roomKey = localStorage.getItem("roomKey");
        if (roomKey) {
            // The signaling client attaches the current room key to every message.
            exitSignalRef.current();
        }
        disconnectRef.current();
        localStorage.removeItem("roomKey");
        window.location.reload();
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
                        <span>{peerStateLabel}</span>
                        <span>{heartbeatLatency === null ? "--" : `${heartbeatLatency} ms`}</span>
                    </div>
                    <button className={`theme-button ${resolvedTheme}`} type="button" onClick={toggleTheme} title={`Theme: ${themeName}. Click to switch.`} aria-label={`Theme: ${themeName}. Click to switch.`}>
                        <span className="theme-icon" aria-hidden="true">{themeIcon}</span>
                    </button>
                    {status === "connected" && (
                    <button className="exit-button secondary-button" type="button" onClick={exitShare} title="Exit and disconnect" aria-label="Exit and disconnect">
                        <span aria-hidden="true">❌</span>
                    </button>
                    )}
                </div>
            </header>
            {status === "connected" ? renderConnectedWorkspace() : isWaitingForPeer ? <section className="waiting-screen" aria-label="Waiting for paired device">
                <div className="waiting-card">
                    <div className="waiting-indicator" aria-hidden="true"><span /></div>
                    <div className="eyebrow">Room ready</div>
                    <h1>Waiting for the other device</h1>
                    <p>Your device has joined the room. Keep this page open while the paired device connects.</p>
                    <div className="waiting-code"><span>Pairing code</span><strong>{pairKey}</strong></div>
                </div>
            </section> : <section className="pair-screen" aria-label="Pair devices">
                <div className="pair-card">
                    <h1>Pair a device</h1>
                    <p className="muted">Scan the QR code or enter this pairing code on other device.</p>
                    {pairKey && (
                        <div className="qr-frame"><img src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(pairKey)}`} alt="Pairing QR code" /></div>
                    )}
                    <div className="your-code"><span>Pairing code</span><strong>{pairKey || "Preparing..."}</strong><button className="icon-button" type="button" title="Copy pairing code" onClick={() => navigator.clipboard?.writeText(pairKey)}>Copy</button></div>
                    <label className="field-label" htmlFor="target-key">Enter the other device's code</label>
                    <div className="join-row"><input id="target-key" placeholder="Pairing code" value={targetPairKey} onChange={(event) => setTargetPairKey(event.target.value)} /><button className="camera-button" type="button" title="Scan QR code" onClick={() => void scanPairCode()}>📷</button><button className="primary-button" type="button" onClick={() => pairRef.current(targetPairKey)}>Pair</button></div>
                </div>
            </section>}
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
