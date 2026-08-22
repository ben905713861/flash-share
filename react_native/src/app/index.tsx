import { useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Modal,
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
import storage from "@/components/storage";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { PairingCodeScanner } from "@/components/pairing-code-scanner";
import { C, s } from "./styles";

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

const transferStatusLabel: Record<FileTransferStatus, string> = {
    awaiting_approval: "Awaiting approval",
    queued: "Queued",
    transferring: "Transferring",
    completed: "Completed",
    declined: "Declined",
    failed: "Failed",
};

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

    const [activeTab, setActiveTab] = useState<"message" | "files">("message");
    const [peerConnectionState, setPeerConnectionState] = useState<RTCIceConnectionState>("new");
    const [heartbeatLatency, setHeartbeatLatency] = useState<number | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<TransferFile[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSendingFile, setIsSendingFile] = useState(false);
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

    const renderTransferList = () => {
        const title = selectedFiles.length > 0 ? "Sending files" : "Receiving files";
        if (fileTransferProgress.length === 0) {
            return (
                <></>
            );
        }
        return (
            <View style={[s.transferTask, { borderColor: palette.border }]}>
                <Text style={[s.transferTitle, { color: palette.text }]}>{title}</Text>
                {fileTransferProgress.map((file) => {
                    const percent =
                        file.size === 0
                            ? 100
                            : Math.round((file.transferred / file.size) * 100);
                    return (
                        <View key={file.filename} style={s.transferFile}>
                            <View style={s.transferSummary}>
                                <Text
                                    numberOfLines={1}
                                    style={[s.transferName, { color: palette.text }]}
                                >
                                    {file.filename}
                                </Text>
                                <Text style={{ color: palette.muted }}>
                                    {formatBytes(file.size)}
                                </Text>
                                <Text style={[s.transferStatus, { color: palette.muted }]}>
                                    {transferStatusLabel[file.status]}
                                </Text>
                            </View>
                            {(file.status === "transferring" ||
                                file.status === "completed") && (
                                <>
                                    <View style={s.progressTrack}>
                                        <View
                                            style={[
                                                s.progressValue,
                                                { width: `${Math.max(0, Math.min(percent, 100))}%` },
                                            ]}
                                        />
                                    </View>
                                    <Text
                                        style={{ color: palette.muted }}
                                    >{`${formatBytes(file.transferred)} of ${formatBytes(file.size)} (${percent}%)`}</Text>
                                </>
                            )}
                        </View>
                    );
                })}
            </View>
        );
    };

    const renderConnectedWorkspace = () => (
        <View style={s.workspace}>
            <View style={s.tabs}>
                <Pressable
                    accessibilityRole="tab"
                    style={[s.tab, activeTab === "message" && s.activeTab]}
                    onPress={() => setActiveTab("message")}
                >
                    <Text style={s.tabText}>Text</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="tab"
                    style={[s.tab, activeTab === "files" && s.activeTab]}
                    onPress={() => setActiveTab("files")}
                >
                    <Text style={s.tabText}>File</Text>
                </Pressable>
            </View>
            {activeTab === "message" ? (
                <View style={s.toolBlock}>
                    <TextInput
                        multiline
                        value={userText}
                        onChangeText={setUserText}
                        placeholder="Write a note for the other device..."
                        placeholderTextColor={palette.muted}
                        style={[
                            s.messageInput,
                            { color: palette.text, borderColor: palette.border },
                        ]}
                    />
                    <View style={s.footer}>
                        <Text style={{ color: palette.muted }}>
                            {userText.length} characters
                        </Text>
                        <Pressable
                            style={[s.primary, !userText.trim() && s.disabled]}
                            disabled={!userText.trim()}
                            onPress={() => sendTextRef.current(userText)}
                        >
                            <Text style={s.primaryText}>Send message</Text>
                        </Pressable>
                    </View>
                </View>
            ) : (
                <View style={s.toolBlock}>
                    <Pressable
                        style={[s.filePicker, { borderColor: palette.border }]}
                        disabled={isSendingFile}
                        onPress={() => void onFilesSelected()}
                    >
                        <Text style={[s.filePickerTitle, { color: palette.text }]}>
                            {selectedFiles.length
                                ? `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected`
                                : "Choose files to share"}
                        </Text>
                        <Text style={{ color: palette.muted }}>
                            {selectedFiles.length
                                ? selectedFiles
                                        .map((file) => `${file.name} (${formatBytes(file.size)})`)
                                        .join(" · ")
                                : "Any file type. The other device chooses where to save it."}
                        </Text>
                    </Pressable>
                    {renderTransferList()}
                    <View style={s.footer}>
                        <Text style={{ color: palette.muted }}>
                            {selectedFiles.length
                                ? `${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))} ready`
                                : "No files selected"}
                        </Text>
                        <Pressable
                            style={[
                                s.primary,
                                (!selectedFiles.length || isSendingFile) && s.disabled,
                            ]}
                            disabled={!selectedFiles.length || isSendingFile}
                            onPress={() => sendFileRef.current(selectedFiles)}
                        >
                            <Text style={s.primaryText}>
                                {isSendingFile ? "Awaiting approval" : "Send files"}
                            </Text>
                        </Pressable>
                    </View>
                </View>
            )}
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
                        <ThemeSwitcher
                            themePreference={themePreference}
                            onChange={setThemePreference}
                        />
                        {page !== "pairPage" && (
                            <Pressable accessibilityLabel="Exit sharing" onPress={exitShare}>
                                <Text style={s.exit}>×</Text>
                            </Pressable>
                        )}
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
                    <View
                        style={[
                            s.card,
                            { backgroundColor: palette.card, borderColor: palette.border },
                        ]}
                    >
                        <Text style={[s.heading, { color: palette.text }]}>
                            Pair a device!
                        </Text>
                        <Text style={{ color: palette.muted }}>
                            Enter this pairing code on the other device.
                        </Text>
                        <View style={s.code}>
                            <Text style={{ color: palette.text }}>Pairing code</Text>
                            <View style={s.qrFrame}>
                                {pairKey ? (
                                    <QRCode value={pairKey} size={180} />
                                ) : (
                                    <ActivityIndicator color="#2f6fed" />
                                )}
                            </View>
                            <Text style={[s.codeValue, { color: palette.text }]}>
                                {pairKey || "Preparing..."}
                            </Text>
                        </View>
                        <Text style={{ color: palette.text }}>Other device code</Text>
                        <View style={[s.inputContainer, { borderColor: palette.border }]}>
                            <TextInput
                                value={targetPairKey}
                                onChangeText={setTargetPairKey}
                                placeholder="Pairing code"
                                placeholderTextColor={palette.muted}
                                style={[
                                    s.input,
                                    { color: palette.text },
                                ]}
                            />
                            <PairingCodeScanner onScanned={(code) => {
                                setTargetPairKey(code);
                                pairRef.current(code);
                            }} />
                        </View>
                        <Pressable
                            style={s.primary}
                            onPress={() => pairRef.current(targetPairKey)}
                        >
                            <Text style={s.primaryText}>Pair</Text>
                        </Pressable>
                    </View>
                )}
            </ScrollView>
            <Modal
                transparent
                visible={isReceiveDialogOpen}
                animationType="fade"
                onRequestClose={() => rejectFileRef.current()}
            >
                <View style={s.modalBackdrop}>
                    <View
                        style={[
                            s.dialog,
                            { backgroundColor: palette.card, borderColor: palette.border },
                        ]}
                    >
                        <Text style={[s.heading, { color: palette.text }]}>
                            Incoming files
                        </Text>
                        <Text style={{ color: palette.muted }}>
                            The paired device wants to send {incomingFiles.length} file
                            {incomingFiles.length <= 1 ? "" : "s"}.
                        </Text>
                        {incomingFiles.map((file) => (
                            <View style={s.incomingFile} key={file.filename}>
                                <Text style={{ color: palette.text }}>{file.filename}</Text>
                                <Text style={{ color: palette.muted }}>
                                    {formatBytes(file.size)}
                                </Text>
                            </View>
                        ))}
                        <View style={s.footer}>
                            <Pressable
                                style={s.secondary}
                                onPress={() => rejectFileRef.current()}
                            >
                                <Text style={s.secondaryText}>Decline</Text>
                            </Pressable>
                            <Pressable
                                style={s.primary}
                                onPress={() => void acceptFileRef.current()}
                            >
                                <Text style={s.primaryText}>Choose folder & receive</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}
