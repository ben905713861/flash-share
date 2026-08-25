import { useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    useColorScheme,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import QRCode from "react-native-qrcode-svg";
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
import { C, s } from "@/styles";
import {Directory, File, FileMode, Paths} from "expo-file-system";
import RNFS from 'react-native-fs';

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
            Alert.alert("Duplicate filenames", "Files with duplicate names cannot be selected together.");
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
                                console.log("size:", sourceFile.size);

                                // 1. 创建 Cache 中的目标文件
                                const cacheFile = new File(
                                    Paths.cache,
                                    `webrtc-${Date.now()}-${sourceFile.name}`
                                );

                                // 2. 把 content:// 文件复制到 App Cache
                                sourceFile.copy(cacheFile);

                                console.log("cache:", cacheFile.uri);
                                console.log("cache size:", cacheFile.size);

                                // 3. 从 App 自己的 file:// 文件读取
                                const fileHandle = cacheFile.open(FileMode.ReadOnly);

                                try {
                                    while (true) {
                                        try {
                                            const bytes = fileHandle.readBytes(64 * 1024);

                                            console.log(
                                                "offset:",
                                                fileHandle.offset,
                                                "size:",
                                                fileHandle.size,
                                                "bytes:",
                                                bytes.length
                                            );

                                            if (bytes.length === 0) {
                                                break;
                                            }
                                        } catch (e) {
                                            console.error("readBytes failed:", e);
                                            console.error("offset:", fileHandle.offset);
                                            console.error("size:", fileHandle.size);
                                            throw e;
                                        }
                                    }
                                } finally {
                                    fileHandle.close();
                                }
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
                {page === "workPage" ? (
                    renderConnectedWorkspace()
                ) : page === "joinRoomWaitPage" || page === "connectingPage" ? (
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
                            {page === "joinRoomWaitPage"
                                ? "Your device has joined the room. Keep this page open while the paired device connects."
                                : "Your devices are negotiating a direct connection. Keep this page open."}
                        </Text>
                        {page === "joinRoomWaitPage" && (
                            <View style={s.qrFrame}>
                                {pairKey ? (
                                    <QRCode value={pairKey} size={180} />
                                ) : (
                                    <ActivityIndicator color="#2f6fed" />
                                )}
                            </View>
                        )}
                    </View>
                ) : (
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
        </SafeAreaView>
    );
}
