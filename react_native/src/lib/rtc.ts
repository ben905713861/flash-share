export type RTCIceCandidateInit = Record<string, unknown>;
export type RTCSessionDescriptionInit = Record<string, unknown>;

export type RTCIceCandidate = {
    toJSON: () => RTCIceCandidateInit;
};

export type RTCDataChannel = {
    readyState: string;
    bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    binaryType: string;
    onopen: (() => void) | null;
    onmessage: ((event: unknown) => void) | null;
    onclose: (() => void) | null;
    send: (data: string | ArrayBuffer | Uint8Array) => void;
    close: () => void;
};

export type RTCPeerConnection = {
    localDescription: unknown;
    iceConnectionState: RTCIceConnectionState;
    onicecandidate: ((event: {candidate: RTCIceCandidate | null}) => void) | null;
    ondatachannel: ((event: {channel: RTCDataChannel}) => void) | null;
    oniceconnectionstatechange: (() => void) | null;
    createDataChannel: (label: string) => RTCDataChannel;
    addIceCandidate: (candidate: RTCIceCandidate) => Promise<void>;
    createOffer: () => Promise<unknown>;
    createAnswer: () => Promise<unknown>;
    setLocalDescription: (description: unknown) => Promise<void>;
    setRemoteDescription: (description: unknown) => Promise<void>;
    close: () => void;
};

export declare const RTCPeerConnection: {
    new (configuration?: unknown): RTCPeerConnection;
};
export declare const RTCIceCandidate: {
    new (data: RTCIceCandidateInit): RTCIceCandidate;
};
export declare const RTCSessionDescription: {
    new (data: unknown): unknown;
};
