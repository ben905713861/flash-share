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

export function App() {
    const [pairKey, setPairKey] = useState("");
    const [targetPairKey, setTargetPairKey] = useState("");
    const [userText, setUserText] = useState("");

    const [status, setStatus] = useState<ConnectionStatus>("connecting");
    const [statusText, setStatusText] = useState("Connecting to signaling server");
    const [activity, setActivity] = useState<string[]>(["Preparing secure connection"]);

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
    const pairRef = useRef<(targetKey: string) => void>(() => {});

    useEffect(() => {
        const handleSignal = async (type: string, data: any) => {
            if (type === "PENDING_PAIR_SUCC") {
                updateStatus("ready", "Share your code to pair a device");
                addActivity("Pairing code registered");
            } else if (type === "PENDING_PAIR_FAIL" || type === "PAIR_FAIL" || type === "JOIN_ROOM_FAIL") {
                clearConnHistory();
                addActivity("Pairing failed. A new code is ready.");
            } else if (type === "PAIR_SUCC") {
                localStorage.setItem("roomKey", data.roomKey);
                updateStatus("waiting", "Pairing complete. Establishing connection");
                sendSignal("JOIN_ROOM");
            } else if (type === "JOIN_ROOM_WAIT") {
                updateStatus("waiting", "Waiting for the paired device");
            } else if (type === "JOIN_ROOM_SUCC") {
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

        const addActivity = (entry: string) => {
            setActivity((items) => [entry, ...items].slice(0, 4));
        }

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
            addActivity(
                `${fileDetails.length} incoming file${fileDetails.length === 1 ? "" : "s"} awaiting approval`,
            );
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
            webSocket.dispose();
            webRTC.dispose();
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

    const readyToSend = status === "connected";

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
                            onChange={(event) => setTargetPairKey(event.target.value)}
                        />
                        <button
                            className="primary-button"
                            type="button"
                            onClick={() => pairRef.current(targetPairKey)}
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
