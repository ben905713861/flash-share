
import {RTCIceCandidate, RTCPeerConnection, RTCSessionDescription} from "./rtc";

const FILE_BUFFER_LOW_WATER_MARK = 1 * 1024 * 1024;

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
    onPeerConnectionState: (state: RTCIceConnectionState) => void;
    onHeartbeat: (latency: number) => void;
    onDataChannelReceiveText: (value: string) => void;
    onFileChannelReceiveText: (value: string) => void;
    onFileChannelReceiveBytes: (bytes: any) => Promise<void>;
    onFileChannelClose: () => void;
    // fileRequestComes: (fileDetails: FileDetail[]) => void;
    // setIsSendingFile: (value: boolean) => void;
    // clearSelectedFiles: () => void;
    // initFileProgress: (fileDetails: FileDetail[]) => void;
    // updateFileTransferProgress: (filename: string, transferred: number, status: FileTransferStatus) => void;
    // updateFileTransferStatus: (status: FileTransferStatus) => void;
};

const FILE_BUFFER_HIGH_WATER_MARK = 4 * 1024 * 1024;

export const createWebRTC = ({
    sendSignal,
    onRestartPeerConnection,
    onPeerConnectionState,
    onHeartbeat,
    onDataChannelReceiveText,
    onFileChannelReceiveText,
    onFileChannelReceiveBytes,
    onFileChannelClose,

    // fileRequestComes,
    // setIsSendingFile,
    // clearSelectedFiles,
    // initFileProgress,
    // updateFileTransferProgress,
    // updateFileTransferStatus,
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
    const iceBuffer: RTCIceCandidate[] = [];

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


    const dataChannelInit = () => {
        if (!dataChannel) {
            return;
        }
        dataChannel.onopen = () => console.log("Message channel connected");
        dataChannel.onmessage = (event: any) => {
            onDataChannelReceiveText(event.data);
            console.log("Message received from paired device");
        };
        dataChannel.onclose = () => console.log("Message channel closed");
    };

    const fileChannelInit = () => {
        console.log('fileChannelInit')
        if (!fileChannel) {
            return;
        }
        const channel = fileChannel;
        channel.bufferedAmountLowThreshold = FILE_BUFFER_LOW_WATER_MARK;
        channel.binaryType = "arraybuffer";
        channel.onopen = () => console.log("File channel connected");
        channel.onmessage = async (event: any) => {
            if (typeof event.data === "string") {
                onFileChannelReceiveText(event.data);
                return;
            }
            const bytes = event.data instanceof ArrayBuffer
                ? new Uint8Array(event.data)
                : event.data instanceof Uint8Array
                    ? event.data
                    : undefined;
            if (bytes) {
                await onFileChannelReceiveBytes(bytes);
            }
        };
        channel.onclose = () => {
            console.log("File channel closed")
            onFileChannelClose();
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
                    const latency = Math.max(0, lastPongAt - sentAt);
                    console.debug("onHeartbeat=", latency)
                    onHeartbeat(latency);
                }
            }
        };
        heartBeatChannel.onclose = () => {
            console.log("HeartBeat channel closed")
        };
    };

    const restartPeerConnection = () => {
        console.log("restartPeerConnection");
        globalThis.clearTimeout(iceDisconnectTimer);
        globalThis.clearInterval(heartBeatInterval);
        heartBeatInterval = undefined;
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
                console.log("connected", "Secure peer-to-peer connection active");
                console.log("Devices connected directly");
            } else if (peer.iceConnectionState === "disconnected") {
                console.log("iceConnectionState=", "disconnected");
                iceDisconnectTimer = globalThis.setTimeout(() => {
                    if (peer?.iceConnectionState === "disconnected" || peer?.iceConnectionState === "failed") {
                        restartPeerConnection();
                        console.log("onRestartPeerConnection");
                        onRestartPeerConnection();
                    }
                }, 60000);
            } else if (peer.iceConnectionState === "failed") {
                restartPeerConnection();
                onRestartPeerConnection();
            }
        };
    };

    const textChannelSend = (message: string): boolean => {
        if (dataChannel?.readyState !== "open") {
            console.log("error", "Connect a device before sending a message");
            return false;
        }
        if (!message.trim()) {
            return false;
        }
        dataChannel.send(message);
        console.log("Message sent");
        return true;
    };

    const fileChannelSend = (content: any): boolean => {
        if (fileChannel?.readyState === "open") {
            fileChannel.send(JSON.stringify(content));
            return true;
        }
        return false;
    };

    const fileChannelSendBytes = async (bytes: any): Promise<void> => {
        if (fileChannel?.readyState !== "open") {
            throw new Error("File channel closed");
        }
        if (fileChannel.bufferedAmount >= FILE_BUFFER_HIGH_WATER_MARK) {
            console.log("waitForFileChannelDrain");
            await waitForFileChannelDrain(fileChannel);
        }
        fileChannel.send(bytes);
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

    const createOffer = async (data: any) => {
        console.log("createOffer, isOfferer=", data.isOfferer);
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
            console.log("error", "Unable to create a peer connection");
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
            console.log("error", "Unable to establish peer connection");
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

    const dispose = () => {
        globalThis.clearTimeout(iceDisconnectTimer);
        globalThis.clearInterval(heartBeatInterval);
        heartBeatInterval = undefined;
        dataChannel?.close();
        fileChannel?.close();
        heartBeatChannel?.close();
        peer?.close();
    };

    init();
    return { createOffer, sdp, sdpAnswer, iceSwap, textChannelSend, fileChannelSend, fileChannelSendBytes, dispose };
};
