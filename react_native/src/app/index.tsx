import React, { useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Pressable,
    ScrollView,
    Text,
    useColorScheme,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createWebSocket } from "@/lib/websocket";
import {applyThemePreference, type ThemePreference} from "@/lib/theme";
import {createWebRTC} from "@/lib/webrtc";
import storage from "@/lib/storage";
import { PairDevice } from "@/components/pair-device";
import {TextWorkspace, TextWorkspaceRef} from "@/components/text-workspace";
import {FileWorkspace, FileWorkspaceRef} from "@/components/file-workspace";
import { SettingsModal } from "@/components/settings-modal";
import { AlertModal, showAlert, showConfirm } from "@/components/alert-modal";
import { C, s } from "@/styles";
import {File} from "expo-file-system";
import NativeFileReaderModule from '@/../modules/native-file-reader/src/NativeFileReaderModule';


const THEME_STORAGE_KEY = "flash-share-theme";

export default function App() {
    const colorScheme = useColorScheme();
    const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
        const saved = storage.get(THEME_STORAGE_KEY);
        return saved === "light" || saved === "dark" ? saved : "system";
    });
    const resolvedTheme = themePreference === "system"
        ? (colorScheme === "dark" ? "dark" : "light")
        : themePreference;
    const palette = C[resolvedTheme];

    useEffect(() => {
        applyThemePreference(themePreference);
        if (themePreference === "system") {
            storage.remove(THEME_STORAGE_KEY);
        } else {
            storage.set(THEME_STORAGE_KEY, themePreference);
        }
    }, [themePreference]);

    const [page, setPage] = useState("pairPage");
    const [connectionSession, setConnectionSession] = useState(0);

    const [pairKey, setPairKey] = useState("");
    const [targetPairKey, setTargetPairKey] = useState("");
    // const [userText, userTextComes] = useState("");

    const [peerConnectionState, setPeerConnectionState] = useState<RTCIceConnectionState>("new");
    const [heartbeatLatency, setHeartbeatLatency] = useState<number | null>(null);
    // const [selectedFiles, setSelectedFiles] = useState<TransferFile[]>([]);
    // const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    // const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    // const [isSendingFile, setIsSendingFile] = useState(false);
    const [isSettingsOpen, setSettingsOpen] = useState(false);
    // const [fileTransferProgress, setFileTransferProgress] = useState<FileTransferProgress[]>([]);
    // functions: sendText, sendFile, acceptFile, rejectFile, pair
    // const sendTextRef = useRef<(text: string) => void>(() => {});
    // const sendFileRef = useRef<(files: TransferFile[]) => void>(() => {});
    // const acceptFileRef = useRef<() => Promise<void>>(async () => {});
    // const rejectFileRef = useRef<() => void>(() => {});
    const webRTCRef = useRef<ReturnType<typeof createWebRTC>>(null);

    const disconnectRef = useRef<() => void>(() => {});
    const exitSignalRef = useRef<() => void>(() => {});
    const pairRef = useRef<(targetKey: string) => void>(() => {});
    const textWorkspaceRef: React.Ref<TextWorkspaceRef> = useRef(null);
    const fileWorkspaceRef: React.Ref<FileWorkspaceRef> = useRef(null);

    useEffect(() => {
        let pairWebSocket: ReturnType<typeof createWebSocket> | undefined;
        let roomWebSocket: ReturnType<typeof createWebSocket> | undefined;

        const handleSignalError = (error: unknown) => {
            console.error("Failed to handle signaling message", error);
            const message = error instanceof Error ? error.message : "Unable to process signaling message";
            showAlert("Connection error", message);
            console.log("error", message);
        };

        const handleSignal = async (type: string, data: any) => {
            if (type === "PENDING_PAIR_SUCC") {
                setPairKey(data.pairKey);
                setPage("pairPage");
                console.log("ready", "Share your code to pair a device");
            } else if (type === "PAIR_STARTED") {
                showAlert("Pairing verification code", `Your verification code is: ${data.passcode}`);
            } else if (type === "PAIR_FAIL") {
                const { error } = data;
                showAlert("Error", "failed to pair device, " + error);
            } else if (type === "ERROR") {
                const message = typeof data?.error === "string" ? data.error : "Signaling request failed";
                showAlert("Error", message);
                console.log("error", message);
            } else if (type === "WAITING_PAIR_CONFIRM") {
                const passcode = String(data?.passcode ?? "");
                showConfirm(
                    "Pairing request",
                    `Verification code: ${passcode}\nAccept this device pairing?`,
                    () => sendPairSignal("PAIR_CONFIRM"),
                    () => {
                        sendPairSignal("PAIR_REJECT");
                        clearConnHistory();
                    },
                );
            } else if (type === "PAIR_REJECT") {
                showAlert("Pairing rejected", "The other device rejected the pairing request.");
                console.log("error", "Pairing rejected");
                clearConnHistory();
            }

            else if (type === "PAIR_SUCC") {
                storage.set("roomKey", data.roomKey);
                setPage("connectingPage");
                console.log("waiting", "Pairing complete. Establishing connection");
                pairWebSocket?.dispose();
                createRoomWs(data.roomKey);
            } else if (type === "JOIN_ROOM_WAIT") {
                setPage("joinRoomWaitPage");
                console.log("waiting", "Waiting for the paired device");
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

        const sendPairSignal = (type: string, data: unknown = {}) => {
            pairWebSocket?.send(type, data);
        };

        const sendRoomSignal = (type: string, data: unknown = {}) => {
            roomWebSocket?.send(type, data);
        };

        const createPairWs = (targetPairKey?: string, passcode?: string) => {
            roomWebSocket?.dispose();
            roomWebSocket = undefined;
            pairWebSocket?.dispose();
            pairWebSocket = createWebSocket({
                type: "pair",
                attachData: {
                    targetPairKey,
                    passcode,
                },
                onClose: (event) => {
                    if (event.code === 1008) {
                        showAlert("Error", event.reason);
                        return true;
                    }
                    return false;
                },
                onMessage: (type, data) => {
                    void handleSignal(type, data).catch(handleSignalError);
                },
            });
        };

        const createRoomWs = (roomKey: string) => {
            pairWebSocket?.dispose();
            pairWebSocket = undefined;
            roomWebSocket?.dispose();
            roomWebSocket = createWebSocket({
                type: "room",
                attachData: { roomKey },
                onClose: (event) => {
                    if (event.code === 1008 || event.code === 1013) {
                        showAlert("Error", event.reason);
                        clearConnHistory();
                        return true;
                    }
                    return false;
                },
                onMessage: (type, data) => {
                    void handleSignal(type, data).catch(handleSignalError);
                },
            });
        };

        const clearConnHistory = () => {
            webRTC.dispose();
            setTargetPairKey("");
            storage.remove("roomKey");
            setPage("pairPage");
            createPairWs();
            console.log("ready", "Ready to pair with another device");
        };

        const webRTC: ReturnType<typeof createWebRTC> = createWebRTC({
            sendSignal: sendRoomSignal,
            onRestartPeerConnection: () => roomWebSocket?.restart(),
            onPeerConnectionState: (nextState) => {
                if (nextState === "connected" || nextState === "completed") {
                    setPage("workPage");
                }
                setPeerConnectionState(nextState);
            },
            onHeartbeat: setHeartbeatLatency,
            onDataChannelReceiveText: (value) => { textWorkspaceRef.current?.setUserText(value) },
            onFileChannelReceiveText: (value) => { fileWorkspaceRef.current?.onFileChannelReceiveText(value) },
            onFileChannelReceiveBytes: async (bytes) => { fileWorkspaceRef.current?.onFileChannelReceiveBytes(bytes) },
            onFileChannelClose: () => { fileWorkspaceRef.current?.onFileChannelClose() },
        });
        webRTCRef.current = webRTC;


        exitSignalRef.current = () => sendRoomSignal("EXIT");
        disconnectRef.current = () => {
            webRTC.dispose();
            pairWebSocket?.dispose();
            pairWebSocket = undefined;
            roomWebSocket?.dispose();
            roomWebSocket = undefined;
        };


        pairRef.current = (targetKey) => {
            if (!targetKey.trim()) {
                console.log("error", "Enter the other device's pairing code");
                return;
            }
            const passcode = String(Math.floor(100000 + Math.random() * 900000));
            createPairWs(targetKey.trim(), passcode);
            console.log("waiting", "Requesting a secure pairing");
        }
        const roomKey = storage.get("roomKey");
        if (roomKey) {
            createRoomWs(roomKey);
        } else {
            createPairWs();
        }
        return () => {
            disconnectRef.current();
        };
    }, [connectionSession]); // empty array: only execute 1 time when load the page


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

    const renderConnectedWorkspace = () => (
        <View style={s.workspace}>
                <TextWorkspace
                    ref={textWorkspaceRef}
                    palette={palette}
                    textChannelSend={ (value) => { webRTCRef.current?.textChannelSend(value) } }
                />
            <View style={{ height: 20 }} />
                <FileWorkspace
                    ref={fileWorkspaceRef}
                    palette={palette}
                    fileChannelSend={ (value) => webRTCRef.current!.fileChannelSend(value) }
                    fileChannelSendBytes={ (value) => webRTCRef.current!.fileChannelSendBytes(value) }
                />
        </View>
    );

    return (
        <SafeAreaView style={[s.safe, { backgroundColor: palette.bg }]}>
            <ScrollView contentContainerStyle={s.content}>
                <View style={s.top}>
                    <View style={s.brand}>
                        <Text style={s.mark}>F</Text>
                        <Text style={[s.brandText, { color: palette.text }]}>
                            Flash Share
                        </Text>
                    </View>
                    <View style={s.topActions}>
                        <Text style={{ color: palette.muted }}>
                            {peerConnectionState}{" "}
                            {heartbeatLatency === null ? "" : `${heartbeatLatency} ms`}
                        </Text>
                        <Pressable onPress={
                            async () => {

                                const pickerResult = await File.pickFileAsync({
                                    multipleFiles: false,
                                });

                                if (pickerResult.canceled) {
                                    return;
                                }
                                const sourceFile = pickerResult.result;

                                console.log("source:", sourceFile.uri);

                                const handler = await NativeFileReaderModule.open(sourceFile.uri)
                                console.log(handler);
                                try {
                                    let bytes: Uint8Array | null;
                                    while (true) {
                                        bytes = await NativeFileReaderModule.read(handler, 512 * 1024);
                                        if (bytes === null) {
                                            break;
                                        }
                                        console.log("bytes", bytes.length);
                                    }
                                } finally {
                                    await NativeFileReaderModule.close(handler);
                                }
                                console.log("end");
                            }
                        }>
                            <Text>test</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Open settings"
                            onPress={() => setSettingsOpen(true)}
                            style={s.settingsButton}
                        >
                            <Text style={[s.settingsIcon, { color: palette.text }]}>⚙</Text>
                        </Pressable>
                    </View>
                </View>
                {page === "workPage" &&
                    renderConnectedWorkspace()
                }
                {page === "joinRoomWaitPage" && (
                    <View
                        style={[
                            s.card,
                            { backgroundColor: palette.card, borderColor: palette.border },
                        ]}
                    >
                        <ActivityIndicator color="#2f6fed" />
                        <Text style={[s.heading, { color: palette.text, textAlign: "center" }]}>
                            Waiting for the other device
                        </Text>
                        <Text style={{ color: palette.muted }}>
                            Your device has joined the room. Keep this page open while the paired device connects.
                        </Text>
                    </View>
                )}

                {page === "connectingPage" && (
                    <View
                        style={[
                            s.card,
                            { backgroundColor: palette.card, borderColor: palette.border },
                        ]}
                    >
                        <ActivityIndicator color="#2f6fed" />
                        <Text style={[s.heading, { color: palette.text }]}>
                            Waiting for the other device
                        </Text>
                        <Text style={{ color: palette.muted }}>
                            Your devices are negotiating a direct connection. Keep this page open.
                        </Text>
                    </View>
                )}

                {page === "pairPage" && (
                    <PairDevice
                        pairKey={pairKey}
                        targetPairKey={targetPairKey}
                        palette={palette}
                        onTargetPairKeyChange={setTargetPairKey}
                        onPair={(value) => pairRef.current(value)}
                    />
                )}
            </ScrollView>
            <SettingsModal
                visible={isSettingsOpen}
                themePreference={themePreference}
                palette={palette}
                onThemeChange={setThemePreference}
                onClose={() => setSettingsOpen(false)}
                onLogout={() => {
                    setSettingsOpen(false);
                    exitShare();
                }}
            />
            <AlertModal palette={palette} />
        </SafeAreaView>
    );
}
