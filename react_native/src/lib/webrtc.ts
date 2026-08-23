import {
    appendFileChunk,
    closeFileReader,
    createReceiveFile,
    deleteFile,
    finalizeReceiveFile,
    getFileSize,
    openFileForReading,
    pickReceiveDirectory,
    readFileChunk,
    type ReceiveDirectory,
    type ReceiveFile,
    type TransferFile,
} from "./file-transfer";
import {RTCIceCandidate, RTCPeerConnection, RTCSessionDescription} from "./rtc";

const FILE_CHUNK_SIZE = 256 * 1024;
const FILE_CHUNK_WINDOW = 16;
const FILE_PROGRESS_CHUNK_INTERVAL = 4;
const FILE_BUFFER_HIGH_WATER_MARK = 4 * 1024 * 1024;
const FILE_BUFFER_LOW_WATER_MARK = 1 * 1024 * 1024;

export type ConnectionStatus = "connecting" | "ready" | "waiting" | "connected" | "error";
export type FileDetail = {
    filename: string;
    size: number;
};
export type FileTransferProgress = {
    transferred: number;
    status: FileTransferStatus;
} & FileDetail;
export type FileTransferStatus = "awaiting_approval" | "queued" | "transferring" | "completed" | "declined" | "failed";

type RTCDataChannel = ReturnType<RTCPeerConnection["createDataChannel"]>;

type WebRTCOptions = {
    sendSignal: (type: string, data?: unknown) => void;
    onRestartPeerConnection: () => void;
    updateStatus: (next: ConnectionStatus, text: string) => void;
    onPeerConnectionState: (state: RTCIceConnectionState) => void;
    onHeartbeat: (latency: number) => void;
    addActivity: (entry: string) => void;
    setUserText: (value: string) => void;
    fileRequestComes: (fileDetails: FileDetail[]) => void;
    setIsSendingFile: (value: boolean) => void;
    clearSelectedFiles: () => void;
    initFileProgress: (fileDetails: FileDetail[]) => void;
    updateFileTransferProgress: (filename: string, transferred: number, status: FileTransferStatus) => void;
    updateFileTransferStatus: (status: FileTransferStatus) => void;
};

type FileRequest = {
    type: "file-request";
    fileDetails: FileDetail[];
} | {
    type: "file-request-ack" | "file-request-reject" | "file-continue" | "file-abort";
} | {
    type: "file-start" | "file-start-ack" | "file-start-reject" | "file-end" | "file-end-ack" | "file-end-reject";
    filename: string;
    size: number;
} | {
    type: "file-send-error";
    filename: string;
};

export const createWebRTC = ({
    sendSignal,
    onRestartPeerConnection,
    updateStatus,
    onPeerConnectionState,
    onHeartbeat,
    addActivity,
    setUserText,
    fileRequestComes,
    setIsSendingFile,
    clearSelectedFiles,
    initFileProgress,
    updateFileTransferProgress,
    updateFileTransferStatus,
}: WebRTCOptions) => {
    let peer: RTCPeerConnection | null = null;
    let dataChannel: RTCDataChannel | null = null;
    let fileChannel: RTCDataChannel | null = null;
    let heartBeatChannel: RTCDataChannel | null = null;
    let heartBeatInterval: ReturnType<typeof setInterval> | undefined;
    let iceDisconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let canAddIceCandidate = false;
    let lastPingAt = Date.now();
    let lastPongAt = Date.now();
    let isInterruptFileSending = false;
    const iceBuffer: RTCIceCandidate[] = [];
    let sendingFiles: TransferFile[] = [];
    let wakeupFileSending: (() => void) | undefined;
    let interruptFileSending: (() => void) | undefined;
    let dirPicker: ReceiveDirectory | undefined;
    let writable: ReceiveFile | undefined;
    let fileHandle: ReceiveFile | undefined;
    let chunkIndex = 0;

    const fileChannelSend = (content: FileRequest) => {
        if (fileChannel?.readyState === "open") {
            fileChannel.send(JSON.stringify(content));
        }
    };

    const addBufferedIce = async () => {
        while (iceBuffer.length && peer) {
            await peer.addIceCandidate(iceBuffer.shift()!);
        }
        canAddIceCandidate = true;
    };

    const startHeartbeat = () => {
        if (heartBeatInterval) {
            return;
        }
        heartBeatInterval = globalThis.setInterval(() => {
            if (heartBeatChannel?.readyState === "open") {
                lastPingAt = Date.now();
                heartBeatChannel.send(`ping:${lastPingAt}`);
            }
        }, 5000);
    };

    const waitForFileChannelDrain = (channel: RTCDataChannel) => {
        if (channel.readyState !== "open") {
            return Promise.reject(new Error("File channel closed"));
        }
        if (channel.bufferedAmount <= FILE_BUFFER_LOW_WATER_MARK) {
            return Promise.resolve();
        }
        const eventChannel = channel as any;
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                eventChannel.removeEventListener?.("bufferedamountlow", onLow);
                eventChannel.removeEventListener?.("close", onClose);
                eventChannel.removeEventListener?.("error", onError);
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
            if (eventChannel.addEventListener) {
                eventChannel.addEventListener("bufferedamountlow", onLow, {once: true});
                eventChannel.addEventListener("close", onClose, {once: true});
                eventChannel.addEventListener("error", onError, {once: true});
            } else {
                const poll = () => {
                    if (channel.readyState !== "open") {
                        onClose();
                    } else if (channel.bufferedAmount <= FILE_BUFFER_LOW_WATER_MARK) {
                        onLow();
                    } else {
                        setTimeout(poll, 50);
                    }
                };
                setTimeout(poll, 50);
            }
        });
    };

    const sendSingleFile = async (file: TransferFile) => {
        isInterruptFileSending = false;
        interruptFileSending = () => {
            isInterruptFileSending = true;
        };
        // File.slice() creates a Blob from a Uint8Array in Expo SDK 57, but
        // React Native's Blob implementation does not support that input.
        // Open explicitly as read-only so both file:// and SAF content:// files work.
        const readHandle = openFileForReading(file);
        try {
            for (let offset = 0, chunkIndex = 0; offset < file.size;) {
                if (fileChannel?.readyState !== "open") {
                    throw new Error("File channel closed");
                }
                if (isInterruptFileSending) {
                    throw new Error("File transfer aborted");
                }
                if (fileChannel.bufferedAmount >= FILE_BUFFER_HIGH_WATER_MARK) {
                    await waitForFileChannelDrain(fileChannel);
                }
                const chunk = await readFileChunk(readHandle, Math.min(FILE_CHUNK_SIZE, file.size - offset));
                if (chunk.byteLength === 0) {
                    break;
                }
                fileChannel.send(chunk);
                offset += chunk.byteLength;
                chunkIndex += 1;
                if (chunkIndex % FILE_PROGRESS_CHUNK_INTERVAL === 0) {
                    updateFileTransferProgress(file.name, offset, "transferring");
                }
                if (chunkIndex % FILE_CHUNK_WINDOW === 0) {
                    await new Promise<void>((resolve, reject) => {
                        wakeupFileSending = resolve;
                        interruptFileSending = () => {
                            isInterruptFileSending = true;
                            reject(new Error("File transfer aborted"));
                        };
                    });
                }
            }
        } finally {
            closeFileReader(readHandle);
        }
    };

    const dataChannelInit = () => {
        if (!dataChannel) {
            return;
        }
        dataChannel.onopen = () => addActivity("Message channel connected");
        dataChannel.onmessage = (event: any) => {
            setUserText(event.data);
            addActivity("Message received from paired device");
        };
        dataChannel.onclose = () => addActivity("Message channel closed");
    };

    const fileChannelInit = () => {
        if (!fileChannel) {
            return;
        }
        const channel = fileChannel;
        channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_MARK;
        channel.binaryType = "arraybuffer";
        channel.onopen = () => addActivity("File channel connected");
        channel.onmessage = async (event: any) => {
            if (typeof event.data === "string") {
                let payload: FileRequest;
                try {
                    payload = JSON.parse(event.data) as FileRequest;
                } catch (error) {
                    console.warn("Ignoring malformed file transfer message", error);
                    return;
                }
                const { type } = payload;
                console.log("peer connection payload type", type);
                if (type === "file-request") {
                    const { fileDetails } = payload;
                    console.log("Received file requested, fileDetails", fileDetails);
                    fileRequestComes(fileDetails);
                    initFileProgress(fileDetails);
                } else if (type === "file-request-ack") {
                    updateFileTransferStatus("queued");
                    const file = sendingFiles[0];
                    if (file) {
                        fileChannelSend({ type: "file-start", filename: file.name, size: file.size });
                    }
                } else if (type === "file-request-reject") {
                    setIsSendingFile(false);
                    updateFileTransferStatus("declined");
                    addActivity("File request declined by the other device");
                } else if (type === "file-start") {
                    const { filename, size } = payload;
                    try {
                        if (!dirPicker) {
                            throw new Error("No receive directory selected");
                        }
                        fileHandle = createReceiveFile(dirPicker, filename);
                        writable = fileHandle;
                        chunkIndex = 0;
                        updateFileTransferProgress(filename, 0, "transferring");
                        fileChannelSend({ type: "file-start-ack", filename, size });
                    } catch (e) {
                        console.error("file-start error", e);
                        updateFileTransferProgress(filename, 0, "failed");
                        fileChannelSend({ type: "file-start-reject", filename, size });
                    }
                } else if (type === "file-start-ack") {
                    const { filename } = payload;
                    const file = sendingFiles.find((item) => item.name === filename);
                    if (!file) {
                        return;
                    }
                    updateFileTransferProgress(filename, 0, "transferring");
                    try {
                        addActivity(`Sending ${filename}`);
                        await sendSingleFile(file);
                        fileChannelSend({ type: "file-end", filename, size: file.size });
                    } catch (e) {
                        console.warn("failed to send file, ", filename, e);
                        sendingFiles = [];
                        setIsSendingFile(false);
                        updateFileTransferProgress(filename, 0, "failed");
                        fileChannelSend({ type: "file-send-error", filename });
                    }
                } else if (type === "file-continue") {
                    wakeupFileSending?.();
                } else if (type === "file-abort") {
                    interruptFileSending?.();
                } else if (type === "file-end") {
                    const { filename, size } = payload;
                    try {
                        const receivedSize = fileHandle && await getFileSize(fileHandle);
                        writable = undefined;
                        if (receivedSize === size) {
                            await finalizeReceiveFile(fileHandle!);
                            updateFileTransferProgress(filename, size, "completed");
                            fileChannelSend({ type: "file-end-ack", filename, size });
                            addActivity(`Received ${filename}`);
                        } else {
                            updateFileTransferProgress(filename, -1, "failed");
                            fileChannelSend({ type: "file-end-reject", filename, size });
                            console.warn("file is damaged", filename);
                        }
                    } catch (e) {
                        console.error("exception occurs in file-end process.", e);
                        updateFileTransferProgress(filename, -1, "failed");
                        fileChannelSend({ type: "file-end-reject", filename, size });
                    }
                } else if (type === "file-end-ack") {
                    const { filename, size } = payload;
                    sendingFiles = sendingFiles.filter((item) => item.name !== filename);
                    updateFileTransferProgress(filename, size, "completed");
                    // task completed
                    if (sendingFiles.length === 0) {
                        setIsSendingFile(false);
                        clearSelectedFiles();
                        addActivity("File transfer completed");
                    } else {
                        const file = sendingFiles[0];
                        updateFileTransferProgress(file.name, 0, "transferring");
                        fileChannelSend({ type: "file-start", filename: file.name, size: file.size });
                    }
                } else if (
                    type === "file-send-error" ||
                    type === "file-end-reject" ||
                    type === "file-start-reject"
                ) {
                    const { filename } = payload;
                    console.warn("file transferring", type, filename);
                    sendingFiles = [];
                    setIsSendingFile(false);
                    updateFileTransferProgress(filename, -1, "failed");
                }
                return;
            }
            const bytes = event.data instanceof ArrayBuffer
                ? new Uint8Array(event.data)
                : event.data instanceof Uint8Array
                    ? event.data
                    : undefined;
            if (bytes && writable) {
                try {
                    await appendFileChunk(writable, bytes);
                    chunkIndex += 1;
                    if (chunkIndex % FILE_PROGRESS_CHUNK_INTERVAL === 0) {
                        updateFileTransferProgress(fileHandle!.name, chunkIndex * FILE_CHUNK_SIZE, "transferring");
                    }
                    if (chunkIndex % FILE_CHUNK_WINDOW === 0) {
                        fileChannelSend({ type: "file-continue" });
                    }
                } catch (e) {
                    console.error("failed to receive files", e);
                    debugger
                    fileChannelSend({ type: "file-abort" });
                    try {
                        if (fileHandle) {
                            await deleteFile(fileHandle);
                        }
                    } catch {
                    }
                    writable = undefined;
                    updateFileTransferProgress(fileHandle!.name, -1, "failed");
                }
            }
        };
        channel.onclose = () => {
            interruptFileSending?.();
            setIsSendingFile(false);
            updateFileTransferStatus("failed");
        };
    };

    const heartBeatChannelInit = () => {
        if (!heartBeatChannel) {
            return;
        }
        heartBeatChannel.onopen = startHeartbeat;
        heartBeatChannel.onmessage = (event: any) => {
            if (typeof event.data !== "string") {
                return;
            }
            if (event.data.startsWith("ping:")) {
                heartBeatChannel?.send(event.data.replace("ping:", "pong:"));
            }
            if (event.data.startsWith("pong:")) {
                lastPongAt = Date.now();
                const sentAt = Number(event.data.slice(5));
                if (Number.isFinite(sentAt)) {
                    onHeartbeat(Math.max(0, lastPongAt - sentAt));
                }
            }
        };
    };

    const restartPeerConnection = () => {
        globalThis.clearTimeout(iceDisconnectTimer);
        globalThis.clearInterval(heartBeatInterval);
        dataChannel?.close();
        fileChannel?.close();
        heartBeatChannel?.close();
        peer?.close();
        dataChannel = fileChannel = heartBeatChannel = null;
        peer = null;
        canAddIceCandidate = false;
        iceBuffer.length = 0;
        init();
    };

    const init = () => {
        peer = new RTCPeerConnection({
            iceServers: [
                {urls: "stun:stun.l.google.com:19302"},
            ],
        });
        peer.onicecandidate = (event: any) => {
            if (event.candidate) {
                sendSignal("ICE", event.candidate.toJSON());
            }
        };
        peer.ondatachannel = (event: any) => {
            if (event.channel.label === "chat") {
                dataChannel = event.channel;
                dataChannelInit();
            }
            if (event.channel.label === "file") {
                fileChannel = event.channel;
                fileChannelInit();
            }
            if (event.channel.label === "heartbeat") {
                heartBeatChannel = event.channel;
                heartBeatChannelInit();
            }
        };
        peer.oniceconnectionstatechange = () => {
            if (!peer) {
                return;
            }
            onPeerConnectionState(peer.iceConnectionState);
            if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
                globalThis.clearTimeout(iceDisconnectTimer);
                updateStatus("connected", "Secure peer-to-peer connection active");
                addActivity("Devices connected directly");
            } else if (peer.iceConnectionState === "disconnected") {
                iceDisconnectTimer = globalThis.setTimeout(() => {
                    if (peer?.iceConnectionState === "disconnected" || peer?.iceConnectionState === "failed") {
                        restartPeerConnection();
                        onRestartPeerConnection();
                    }
                }, 60000);
            } else if (peer.iceConnectionState === "failed") {
                restartPeerConnection();
                onRestartPeerConnection();
            }
        };
    };

    const createOffer = async (data: any) => {
        if (!peer) {
            return;
        }
        if (!data.isOfferer) {
            return;
        }
        if (dataChannel || fileChannel || heartBeatChannel) {
            restartPeerConnection();
        }
        dataChannel = peer.createDataChannel("chat");
        dataChannelInit();
        fileChannel = peer.createDataChannel("file");
        fileChannelInit();
        heartBeatChannel = peer.createDataChannel("heartbeat");
        heartBeatChannelInit();
        try {
            await peer.setLocalDescription(await peer.createOffer());
            sendSignal("SDP", peer.localDescription);
        } catch {
            updateStatus("error", "Unable to create a peer connection");
        }
    };

    const sdp = async (data: any) => {
        if (!peer) {
            return;
        }
        try {
            await peer.setRemoteDescription(new RTCSessionDescription(data));
            await addBufferedIce();
            await peer.setLocalDescription(await peer.createAnswer());
            sendSignal("SDP_ANSWER", peer.localDescription);
        } catch {
            updateStatus("error", "Unable to establish peer connection");
        }
    };

    const sdpAnswer = async (data: any) => {
        if (!peer) {
            return;
        }
        await peer.setRemoteDescription(new RTCSessionDescription(data));
        await addBufferedIce();
    };

    const iceSwap = async (data: any) => {
        const candidate = new RTCIceCandidate(data);
        if (canAddIceCandidate) {
            await peer?.addIceCandidate(candidate);
        } else {
            iceBuffer.push(candidate);
        }
    };

    const sendText = (message: string) => {
        if (dataChannel?.readyState !== "open") {
            updateStatus("error", "Connect a device before sending a message");
            return;
        }
        if (!message.trim()) {
            return;
        }
        dataChannel.send(message);
        addActivity("Message sent");
    };

    const sendFile = (files: TransferFile[]) => {
        setIsSendingFile(true);
        if (fileChannel?.readyState !== "open") {
            updateStatus("error", "Connect a device before sending files");
            setIsSendingFile(false);
            return;
        }
        if (files.length === 0) {
            setIsSendingFile(false);
            throw new Error("no file is selected");
        }
        sendingFiles = [...files];
        const fileDetails: FileDetail[] = sendingFiles.map((file) => {
            return { filename: file.name, size: file.size };
        });
        fileChannelSend({
            type: "file-request",
            fileDetails,
        });
        initFileProgress(fileDetails);
        addActivity("Waiting for the other device to approve file transfer");
    };

    const acceptFile = async () => {
        try {
            dirPicker = await pickReceiveDirectory();
            updateFileTransferStatus("queued");
            fileChannelSend({ type: "file-request-ack" });
        } catch {
            updateFileTransferStatus("declined");
            fileChannelSend({ type: "file-request-reject" });
        }
    };

    const rejectFile = () => {
        fileChannelSend({ type: "file-request-reject" });
        updateFileTransferStatus("declined");
    };

    const dispose = () => {
        globalThis.clearTimeout(iceDisconnectTimer);
        globalThis.clearInterval(heartBeatInterval);
        dataChannel?.close();
        fileChannel?.close();
        heartBeatChannel?.close();
        peer?.close();
    };

    init();
    return { createOffer, sdp, sdpAnswer, iceSwap, sendText, sendFile, acceptFile, rejectFile, dispose };
};
