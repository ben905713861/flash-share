const FILE_CHUNK_SIZE = 64 * 1024;
const FILE_CHUNK_WINDOW = 16;
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

type WebRTCOptions = {
    sendSignal: (type: string, data?: unknown) => void;
    onRestartPeerConnection: () => void;
    updateStatus: (next: ConnectionStatus, text: string) => void;
    addActivity: (entry: string) => void;
    setUserText: (value: string) => void;
    fileRequestComes: (fileDetails: FileDetail[]) => void;
    setIsSendingFile: (value: boolean) => void;
    clearSelectedFiles: () => void;
    initFileProgress: (fileDetails: FileDetail[]) => void;
    updateFileTransferProgress: (filename: string, transferred: number, status?: FileTransferStatus) => void;
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
    let heartBeatInterval: number | undefined;
    let iceDisconnectTimer: number | undefined;
    let canAddIceCandidate = false;
    let lastPingAt = Date.now();
    let lastPongAt = Date.now();
    let isInterruptFileSending = false;
    const iceBuffer: RTCIceCandidate[] = [];
    let sendingFiles: File[] = [];
    let wakeupFileSending: (() => void) | undefined;
    let interruptFileSending: (() => void) | undefined;
    let dirPicker: FileSystemDirectoryHandle | undefined;
    let writable: FileSystemWritableFileStream | undefined;
    let fileHandle: FileSystemFileHandle | undefined;
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
        heartBeatInterval = window.setInterval(() => {
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
        isInterruptFileSending = false;
        interruptFileSending = () => {
            isInterruptFileSending = true;
        };
        for (let offset = 0, chunkIndex = 0; offset < file.size; offset += FILE_CHUNK_SIZE) {
            if (fileChannel?.readyState !== "open") {
                throw new Error("File channel closed");
            }
            if (isInterruptFileSending) {
                throw new Error("File transfer aborted");
            }
            if (fileChannel.bufferedAmount >= FILE_BUFFER_HIGH_WATER_MARK) {
                await waitForFileChannelDrain(fileChannel);
            }
            fileChannel.send(await file.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer());
            updateFileTransferProgress(file.name, offset + FILE_CHUNK_SIZE);

            chunkIndex += 1;
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
    };
    const dataChannelInit = () => {
        if (!dataChannel) {
            return;
        }
        dataChannel.onopen = () => addActivity("Message channel connected");
        dataChannel.onmessage = (event) => {
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
        channel.onmessage = async (event) => {
            if (typeof event.data === "string") {
                const payload: FileRequest = JSON.parse(event.data);
                const { type } = payload;
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
                        fileHandle = await dirPicker?.getFileHandle(filename, {
                            create: true,
                        });
                        writable = await fileHandle?.createWritable();
                        if (!writable) {
                            updateFileTransferProgress(filename, 0, "failed");
                            fileChannelSend({ type: "file-start-reject", filename, size });
                            return;
                        }
                        chunkIndex = 0;
                        updateFileTransferProgress(filename, 0, "transferring");
                        fileChannelSend({ type: "file-start-ack", filename, size });
                    } catch {
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
                    } catch {
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
                        await writable?.close();
                        const received = await fileHandle?.getFile();
                        writable = undefined;
                        if (received?.size === size) {
                            updateFileTransferProgress(filename, size, "completed");
                            fileChannelSend({ type: "file-end-ack", filename, size });
                            addActivity(`Received ${filename}`);
                        } else {
                            updateFileTransferProgress(filename, -1, "failed");
                            fileChannelSend({ type: "file-end-reject", filename, size });
                        }
                    } catch {
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
                    sendingFiles = [];
                    setIsSendingFile(false);
                    updateFileTransferProgress(filename, -1, "failed");
                }
                return;
            }
            if (event.data instanceof ArrayBuffer && writable) {
                try {
                    await writable.write(event.data);
                    chunkIndex += 1;
                    updateFileTransferProgress(fileHandle!.name, chunkIndex * FILE_CHUNK_SIZE);
                    if (chunkIndex % FILE_CHUNK_WINDOW === 0) {
                        fileChannelSend({ type: "file-continue" });
                    }
                } catch {
                    fileChannelSend({ type: "file-abort" });
                    await writable.abort();
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
        heartBeatChannel.onmessage = (event) => {
            if (event.data.startsWith("ping:")) {
                heartBeatChannel?.send(event.data.replace("ping:", "pong:"));
            }
            if (event.data.startsWith("pong:")) {
                lastPongAt = Date.now();
            }
        };
    };
    const restartPeerConnection = () => {
        window.clearTimeout(iceDisconnectTimer);
        window.clearInterval(heartBeatInterval);
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
                {urls: "stun:stun.l.google.com:19302"}
            ]
        });
        peer.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignal("ICE", event.candidate);
            }
        };
        peer.ondatachannel = (event) => {
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
            if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
                window.clearTimeout(iceDisconnectTimer);
                updateStatus("connected", "Secure peer-to-peer connection active");
                addActivity("Devices connected directly");
            } else if (peer.iceConnectionState === "disconnected") {
                iceDisconnectTimer = window.setTimeout(() => {
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
        dataChannel = peer!.createDataChannel("chat");
        dataChannelInit();
        fileChannel = peer!.createDataChannel("file");
        fileChannelInit();
        heartBeatChannel = peer!.createDataChannel("heartbeat");
        heartBeatChannelInit();
        try {
            await peer!.setLocalDescription(await peer!.createOffer());
            sendSignal("SDP", peer!.localDescription);
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
    }

    const sdpAnswer = async (data: any) => {
        if (!peer) {
            return;
        }
        await peer.setRemoteDescription(new RTCSessionDescription(data));
        await addBufferedIce();
    }

    const iceSwap = async (data: any) => {
        const candidate = new RTCIceCandidate(data);
        if (canAddIceCandidate) {
            await peer?.addIceCandidate(candidate);
        } else {
            iceBuffer.push(candidate);
        }
    }

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

    const sendFile = (files: File[]) => {
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
        })
        fileChannelSend({
            type: "file-request",
            fileDetails,
        });
        initFileProgress(fileDetails);
        addActivity("Waiting for the other device to approve file transfer");
    };

    const acceptFile = async () => {
        if (!window.showDirectoryPicker) {
            addActivity("This browser cannot choose a download folder");
            updateFileTransferStatus("declined");
            fileChannelSend({ type: "file-request-reject" });
            alert("This browser cannot choose a download folder");
            return;
        }
        try {
            dirPicker = await window.showDirectoryPicker();
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
    }

    const dispose = () => {
        window.clearTimeout(iceDisconnectTimer);
        window.clearInterval(heartBeatInterval);
        dataChannel?.close();
        fileChannel?.close();
        heartBeatChannel?.close();
        peer?.close();
    };

    init();
    return { createOffer, sdp, sdpAnswer, iceSwap, sendText, sendFile, acceptFile, rejectFile, dispose };
};
