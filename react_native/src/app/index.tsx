import { useEffect, useRef, useState } from "react";
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
import {pickTransferFiles, type TransferFile} from "@/lib/file-transfer";
import {applyThemePreference, type ThemePreference} from "@/lib/theme";
import {
    ConnectionStatus,
    FileDetail,
    FileTransferProgress,
    FileTransferStatus,
    createWebRTC,
} from "@/lib/webrtc";
import storage from "@/lib/storage";
import { PairDevice } from "@/components/pair-device";
import { TextWorkspace } from "@/components/text-workspace";
import { FileWorkspace } from "@/components/file-workspace";
import { SettingsModal } from "@/components/settings-modal";
import { AlertModal, showAlert } from "@/components/alert-modal";
import { C, s } from "@/styles";
import {File} from "expo-file-system";
import NativeFileReaderModule from '@/../modules/native-file-reader/src/NativeFileReaderModule';

const makePairKey = () => {
    return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
}

const hasDuplicateFilenames = (files: TransferFile[]) => {
    const names = new Set<string>();
    for (const file of files) {
        if (names.has(file.name)) {
            return true;
        }
        names.add(file.name);
    }
    return false;
};

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
    const [userText, setUserText] = useState("");

    const [peerConnectionState, setPeerConnectionState] = useState<RTCIceConnectionState>("new");
    const [heartbeatLatency, setHeartbeatLatency] = useState<number | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<TransferFile[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSendingFile, setIsSendingFile] = useState(false);
    const [isSettingsOpen, setSettingsOpen] = useState(false);
    const [fileTransferProgress, setFileTransferProgress] = useState<FileTransferProgress[]>([]);
    // functions: sendText, sendFile, acceptFile, rejectFile, pair
    const sendTextRef = useRef<(text: string) => void>(() => {});
    const sendFileRef = useRef<(files: TransferFile[]) => void>(() => {});
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
            } else if (type === "PENDING_PAIR_FAIL") {
                const { error } = data;
                showAlert("Error", "failed to register pairKey, " + error);
                clearConnHistory();
            } else if (type === "PAIR_FAIL") {
                const { error } = data;
                showAlert("Error", "failed to pair device, " + error);
            } else if (type === "JOIN_ROOM_FAIL") {
                const { error } = data;
                showAlert("Error", "failed to join room, " + error);
                clearConnHistory();
            } else if (type === "PAIR_SUCC") {
                storage.set("roomKey", data.roomKey);
                setPage("connectingPage");
                updateStatus("waiting", "Pairing complete. Establishing connection");
                webSocket.dispose();
                webSocket = createWebSocket({
                    type: "room",
                    key: data.roomKey,
                    onMessage: (type, data) => void handleSignal(type, data),
                });
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

        const clearConnHistory = () => {
            setTargetPairKey("");
            storage.remove("roomKey");
            setPage("pairPage");
            const freshKey = makePairKey();
            setPairKey(freshKey);
            webSocket.dispose();
            webSocket = createWebSocket({
                type: "pair",
                key: freshKey,
                onMessage: (type, data) => void handleSignal(type, data),
            });
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

        const updateFileTransferProgress = (filename: string, transferred: number, status: FileTransferStatus) => {
            setFileTransferProgress((fileProgressList) => {
                return fileProgressList.map(fileProgress => {
                    if (fileProgress.filename === filename) {
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

        let webSocket: ReturnType<typeof createWebSocket>;
        const roomKey = storage.get("roomKey");
        if (roomKey) {
            webSocket = createWebSocket({
                type: "room",
                key: roomKey,
                onMessage: (type, data) => void handleSignal(type, data),
            });
        } else {
            const key = makePairKey();
            setPairKey(key);
            webSocket = createWebSocket({
                type: "pair",
                key,
                onMessage: (type, data) => void handleSignal(type, data),
            });
        }

        return () => {
            disconnectRef.current();
        };
    }, [connectionSession]); // empty array: only execute 1 time when load the page

    const onFilesSelected = async () => {
        if (isSendingFile) {
            return;
        }
        const result = await pickTransferFiles();
        if (result.canceled) {
            return;
        }
        if (hasDuplicateFilenames(result.result)) {
            setSelectedFiles([]);
            showAlert("Duplicate filenames", "Files with duplicate names cannot be selected together.");
            return;
        }
        setSelectedFiles(result.result);
    };

    const clearSelectedFiles = () => {
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

    const renderConnectedWorkspace = () => (
        <View style={s.workspace}>
                <TextWorkspace
                    value={userText}
                    palette={palette}
                    onChangeText={setUserText}
                    onSend={(text) => sendTextRef.current(text)}
                />
            <View style={{ height: 20 }} />
                <FileWorkspace
                    selectedFiles={selectedFiles}
                    isSendingFile={isSendingFile}
                    fileTransferProgress={fileTransferProgress}
                    palette={palette}
                    onSelectFiles={() => void onFilesSelected()}
                    onSendFiles={() => sendFileRef.current(selectedFiles)}
                    incomingFiles={incomingFiles}
                    isReceiveDialogOpen={isReceiveDialogOpen}
                    onAcceptFiles={() => acceptFileRef.current()}
                    onRejectFiles={() => rejectFileRef.current()}
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
