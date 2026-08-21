import {useEffect, useRef, useState} from "react";
import {
    ActivityIndicator,
    Alert,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
    useColorScheme
} from "react-native";
import {File} from "expo-file-system";
import {SafeAreaView} from "react-native-safe-area-context";
import { createWebSocket } from "@/lib/websocket";
import {
    ConnectionStatus,
    FileDetail,
    FileTransferProgress,
    FileTransferStatus,
    createWebRTC,
} from "@/lib/webrtc";
import storage from "@/lib/storage";

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
    awaiting_approval: "Awaiting approval",
    queued: "Queued",
    transferring: "Transferring",
    completed: "Completed",
    declined: "Declined",
    failed: "Failed",
};

type ThemePreference = "system" | "light" | "dark";

export default function App() {
    const [page, setPage] = useState("pairPage");
    const [connectionSession, setConnectionSession] = useState(0);

    const [pairKey, setPairKey] = useState("");
    const [targetPairKey, setTargetPairKey] = useState("");
    const [userText, setUserText] = useState("");
    const [activeTab, setActiveTab] = useState<"message" | "files">("message");
    const [peerConnectionState, setPeerConnectionState] = useState<RTCIceConnectionState>("new");
    const [heartbeatLatency, setHeartbeatLatency] = useState<number | null>(null);
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSendingFile, setIsSendingFile] = useState(false);
    const [fileTransferProgress, setFileTransferProgress] = useState<FileTransferProgress[]>([]);
    const systemColorScheme = useColorScheme();
    const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
        const saved = storage.get("flash-share-theme");
        return saved === "light" || saved === "dark" ? saved : "system";
    });
    const systemDark = systemColorScheme === "dark";
    const resolvedTheme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;

    useEffect(() => {
        if (themePreference === "system") {
            storage.remove("flash-share-theme");
        } else {
            storage.set("flash-share-theme", themePreference);
        }
    }, [themePreference]);

    const toggleTheme = () => {
        setThemePreference((current) => {
            if (current === "system") return "light";
            if (current === "light") return "dark";
            return "system";
        });
    };
    const themeIcon = themePreference === "system" ? "◒" : themePreference === "light" ? "☀" : "🌙";
    // functions: sendText, sendFile, acceptFile, rejectFile,pair
    const sendTextRef = useRef<(text: string) => void>(() => {});
    const sendFileRef = useRef<(files: File[]) => void>(() => {});
    const acceptFileRef = useRef<() => Promise<void>>(async () => {});
    const rejectFileRef = useRef<() => void>(() => {});
    const disconnectRef = useRef<() => void>(() => {});
    const exitSignalRef = useRef<() => void>(() => {});
    const pairRef = useRef<(targetKey: string) => void>(() => {});

    useEffect(() => {
        if (Platform.OS === "web") {
            globalThis.alert("WebRTC requires an Android or iOS development build");
            return;
        }

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
        const result = await File.pickFileAsync({multipleFiles: true});
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
        return <View style={[s.transferTask, {borderColor: palette.border}]}><Text
            style={[s.transferTitle, {color: palette.text}]}>{title}</Text>{fileTransferProgress.map(file => {
            const percent = file.size === 0 ? 100 : Math.round((file.transferred / file.size) * 100);
            return <View key={file.filename} style={s.transferFile}><View style={s.transferSummary}><Text
                numberOfLines={1} style={[s.transferName, {color: palette.text}]}>{file.filename}</Text><Text
                style={{color: palette.muted}}>{formatBytes(file.size)}</Text><Text
                style={[s.transferStatus, {color: palette.muted}]}>{transferStatusLabel[file.status]}</Text></View>{(file.status === "transferring" || file.status === "completed") && <>
                <View style={s.progressTrack}><View
                    style={[s.progressValue, {width: `${Math.max(0, Math.min(percent, 100))}%`}]}/></View><Text
                style={{color: palette.muted}}>{`${formatBytes(file.transferred)} of ${formatBytes(file.size)} (${percent}%)`}</Text></>}
            </View>;
        })}</View>;
    };

    const renderConnectedWorkspace = () => <View style={s.workspace}><View style={s.tabs}><Pressable
        style={[s.tab, activeTab === "message" && s.activeTab]} onPress={() => setActiveTab("message")}><Text
        style={s.tabText}>Text</Text></Pressable><Pressable style={[s.tab, activeTab === "files" && s.activeTab]}
                                                            onPress={() => setActiveTab("files")}><Text
        style={s.tabText}>File</Text></Pressable></View>{activeTab === "message" ?
        <View style={s.toolBlock}><TextInput multiline value={userText} onChangeText={setUserText}
                                             placeholder="Write a note for the other device..."
                                             placeholderTextColor={palette.muted} style={[s.messageInput, {
            color: palette.text,
            borderColor: palette.border
        }]}/><View style={s.footer}><Text style={{color: palette.muted}}>{userText.length} characters</Text><Pressable
            style={s.primary} disabled={!userText.trim()} onPress={() => sendTextRef.current(userText)}><Text style={s.primaryText}>Send
            message</Text></Pressable></View></View> :
        <View style={s.toolBlock}><Pressable style={[s.filePicker, {borderColor: palette.border}]}
                                             disabled={isSendingFile} onPress={() => void onFilesSelected()}><Text
            style={[s.filePickerTitle, {color: palette.text}]}>{selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected` : "Choose files to share"}</Text><Text
            style={{color: palette.muted}}>{selectedFiles.length ? selectedFiles.map(file => `${file.name} (${formatBytes(file.size)})`).join(" · ") : "Any file type. The other device chooses where to save it."}</Text></Pressable>{renderTransferList()}<View
            style={s.footer}><Text
            style={{color: palette.muted}}>{selectedFiles.length ? `${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))} ready` : "No files selected"}</Text><Pressable
            style={s.primary} disabled={!selectedFiles.length || isSendingFile} onPress={() => sendFileRef.current(selectedFiles)}><Text
            style={s.primaryText}>{isSendingFile ? "Awaiting approval" : "Send files"}</Text></Pressable></View></View>}
    </View>;

    return <SafeAreaView style={[s.safe, {backgroundColor: palette.bg}]}><ScrollView
        contentContainerStyle={s.content}><View style={s.top}><View style={s.brand}><Text style={s.mark}>F</Text><Text
        style={[s.brandText, {color: palette.text}]}>Flash Share</Text></View><View style={s.topActions}><Text
        style={{color: palette.muted}}>{peerConnectionState} {heartbeatLatency === null ? "" : `${heartbeatLatency} ms`}</Text><Pressable
        onPress={toggleTheme}><Text
        style={s.theme}>{themeIcon}</Text></Pressable>{page !== "pairPage" &&
        <Pressable onPress={exitShare}><Text style={s.exit}>×</Text></Pressable>}</View></View><View
        style={s.status}><View
        style={[s.dot, {backgroundColor:"#2f9e68"}]}/></View>{page === "workPage" ? renderConnectedWorkspace() : page === "joinRoomWaitPage" || page === "connectingPage" ?
        <View style={[s.card, {backgroundColor: palette.card, borderColor: palette.border}]}><ActivityIndicator
            color="#2f6fed"/><Text style={[s.heading, {color: palette.text}]}>Waiting for the other device</Text><Text
            style={{color: palette.muted}}>{page === "joinRoomWaitPage" ? "Your device has joined the room. Keep this page open while the paired device connects." : "Your devices are negotiating a direct connection. Keep this page open."}</Text>{page === "joinRoomWaitPage" && <Text style={[s.codeValue, {color: palette.text}]}>{pairKey}</Text>}</View> :
        <View style={[s.card, {backgroundColor: palette.card, borderColor: palette.border}]}><Text
            style={[s.heading, {color: palette.text}]}>Pair a device!</Text><Text style={{color: palette.muted}}>Enter
            this pairing code on the other device.</Text><View style={s.code}><Text style={{color: palette.text}}>Pairing
            code</Text><Text style={s.codeValue}>{pairKey || "Preparing..."}</Text></View><Text
            style={{color: palette.text}}>Other device code</Text><TextInput value={targetPairKey}
                                                                             onChangeText={setTargetPairKey}
                                                                             placeholder="Pairing code"
                                                                             placeholderTextColor={palette.muted}
                                                                             style={[s.input, {
                                                                                 color: palette.text,
                                                                                 borderColor: palette.border
                                                                             }]}/><Pressable style={s.primary}
                                                                                             onPress={() => pairRef.current(targetPairKey)}><Text
            style={s.primaryText}>Pair</Text></Pressable></View>}</ScrollView><Modal transparent
                                                                                          visible={isReceiveDialogOpen}
                                                                                          animationType="fade"
                                                                                          onRequestClose={() => rejectFileRef.current()}><View
        style={s.modalBackdrop}><View
        style={[s.dialog, {backgroundColor: palette.card, borderColor: palette.border}]}><Text
        style={[s.heading, {color: palette.text}]}>Incoming files</Text><Text style={{color: palette.muted}}>The paired
        device wants to
        send {incomingFiles.length} file{incomingFiles.length <= 1 ? "" : "s"}.</Text>{incomingFiles.map(file => <View
        style={s.incomingFile} key={file.filename}><Text style={{color: palette.text}}>{file.filename}</Text><Text
        style={{color: palette.muted}}>{formatBytes(file.size)}</Text></View>)}<View style={s.footer}><Pressable
        style={s.secondary} onPress={() => rejectFileRef.current()}><Text
        style={s.secondaryText}>Decline</Text></Pressable><Pressable style={s.primary}
                                                                     onPress={() => void acceptFileRef.current()}><Text
        style={s.primaryText}>Choose folder & receive</Text></Pressable></View></View></View></Modal></SafeAreaView>;
}

const C = {
    light: {bg: "#f5f6f8", card: "#fff", text: "#18212b", muted: "#687482", border: "#d9dee5"},
    dark: {bg: "#12161b", card: "#1b222a", text: "#f0f3f6", muted: "#a1acb8", border: "#34404d"},
};

const s = StyleSheet.create({
    safe: {flex: 1},
    content: {width: "100%", maxWidth: 720, alignSelf: "center", padding: 24, gap: 20},
    top: {flexDirection: "row", justifyContent: "space-between", alignItems: "center"},
    topActions: {flexDirection: "row", alignItems: "center", gap: 10},
    brand: {flexDirection: "row", alignItems: "center", gap: 10},
    mark: {backgroundColor: "#2f6fed", color: "#fff", fontSize: 22, fontWeight: "800", padding: 8, borderRadius: 8},
    brandText: {fontSize: 20, fontWeight: "700"},
    theme: {fontSize: 22, padding: 8},
    exit: {fontSize: 28, color: "#d9534f", paddingHorizontal: 8},
    status: {flexDirection: "row", alignItems: "center", gap: 8},
    dot: {width: 9, height: 9, borderRadius: 5},
    card: {marginTop: 30, padding: 24, borderRadius: 14, borderWidth: 1, gap: 16},
    heading: {fontSize: 25, fontWeight: "700"},
    code: {alignItems: "center", padding: 18, backgroundColor: "#eef3ff", borderRadius: 10},
    codeValue: {fontSize: 22, fontWeight: "700", marginTop: 5},
    input: {minHeight: 48, borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16},
    primary: {
        backgroundColor: "#2f6fed",
        minHeight: 48,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 20
    },
    primaryText: {color: "#fff", fontWeight: "700", fontSize: 16},
    secondary: {
        minHeight: 48,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: "#9aa4af",
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 20
    },
    secondaryText: {color: "#52606d", fontWeight: "700", fontSize: 16},
    workspace: {marginTop: 20, gap: 14},
    tabs: {flexDirection: "row", gap: 8},
    tab: {paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8, backgroundColor: "#e8edf4"},
    activeTab: {backgroundColor: "#d8e5ff"},
    tabText: {color: "#334155", fontWeight: "700"},
    toolBlock: {gap: 14},
    messageInput: {
        minHeight: 180,
        borderWidth: 1,
        borderRadius: 8,
        padding: 12,
        fontSize: 16,
        textAlignVertical: "top"
    },
    footer: {flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12},
    filePicker: {
        minHeight: 130,
        borderWidth: 1,
        borderStyle: "dashed",
        borderRadius: 8,
        padding: 18,
        justifyContent: "center",
        gap: 8
    },
    filePickerTitle: {fontWeight: "700", fontSize: 16},
    transferTask: {borderWidth: 1, borderRadius: 8, padding: 14, gap: 12},
    transferTitle: {fontWeight: "700", fontSize: 16},
    transferFile: {gap: 5},
    transferSummary: {gap: 4},
    transferName: {fontWeight: "600"},
    transferStatus: {fontWeight: "600"},
    progressTrack: {height: 6, backgroundColor: "#d9dee5", borderRadius: 3, overflow: "hidden"},
    progressValue: {height: 6, backgroundColor: "#2f6fed"},
    incomingFile: {paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#d9dee5", gap: 3},
    modalBackdrop: {flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "center", padding: 24},
    dialog: {borderRadius: 14, borderWidth: 1, padding: 22, gap: 16},
});
