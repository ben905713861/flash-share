import { Modal, Pressable, Text, View } from "react-native";
import { C, s } from "@/styles";
import React, {useImperativeHandle, useRef, useState} from "react";

import {
    pickTransferFiles,
    appendFileChunk,
    closeFileReader,
    createReceiveFile,
    deleteFile,
    finalizeReceiveFile,
    getFileSize,
    openFileForReading,
    pickReceiveDirectory,
    readFileChunk,
    restoreReceiveDirectory,
    type ReceiveDirectory,
    type ReceiveFile,
    type TransferFile,
} from "@/lib/file-transfer";
import {showAlert} from "@/components/alert-modal";
import storage from "@/lib/storage";

const FILE_CHUNK_SIZE = 256 * 1024;
const FILE_CHUNK_WINDOW = 16;
const FILE_PROGRESS_CHUNK_INTERVAL = 4;

type FileWorkspaceProps = {
    ref: React.Ref<FileWorkspaceRef>;
    palette: (typeof C)["light"];
    fileChannelSend: (content: any) => boolean,
    fileChannelSendBytes: (content: any) => Promise<void>,
};

const transferStatusLabel: Record<FileTransferStatus, string> = {
    awaiting_approval: "Awaiting approval", queued: "Queued", transferring: "Transferring",
    completed: "Completed", declined: "Declined", failed: "Failed",
};

const transferStatusColors: Record<FileTransferStatus, { backgroundColor: string; color: string }> = {
    awaiting_approval: { backgroundColor: "#fff3cd", color: "#856404" },
    queued: { backgroundColor: "#e8edf4", color: "#52606d" },
    transferring: { backgroundColor: "#d8e5ff", color: "#2456b8" },
    completed: { backgroundColor: "#d9f2e3", color: "#187044" },
    declined: { backgroundColor: "#fff0d9", color: "#9a5b00" },
    failed: { backgroundColor: "#f9d9d7", color: "#a52a25" },
};

type FileRequest = {
    type: "file-request";
    fileDetails: TransferFile[];
} | {
    type: "file-request-ack" | "file-request-reject" | "file-continue" | "file-abort" | "file-cancel";
} | {
    type: "file-start" | "file-start-ack" | "file-start-reject" | "file-end" | "file-end-ack" | "file-end-reject";
    filename: string;
    size: number;
} | {
    type: "file-send-error";
    filename: string;
};

type FileTransferProgress = {
    transferred: number;
    status: FileTransferStatus;
} & TransferFile;

type FileTransferStatus = "awaiting_approval" | "queued" | "transferring" | "completed" | "declined" | "failed";

export interface FileWorkspaceRef {
    onFileChannelReceiveText: (message: string) => Promise<void>;
    onFileChannelReceiveBytes:  (bytes: any) => Promise<void>;
    onFileChannelClose: () => void,
}

const parseFileRequest = (message: string): FileRequest | undefined => {
    let value: unknown;
    try {
        value = JSON.parse(message);
    } catch (error) {
        console.warn("Ignoring malformed file transfer message", error);
        return undefined;
    }
    if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
        console.warn("Ignoring invalid file transfer message");
        return undefined;
    }
    const payload = value as Record<string, unknown>;
    const type = payload.type as string;
    const requestTypes = new Set(["file-request-ack", "file-request-reject", "file-continue", "file-abort", "file-cancel"]);
    if (requestTypes.has(type)) {
        return {type} as FileRequest;
    }
    if (type === "file-request") {
        if (!Array.isArray(payload.fileDetails) || !payload.fileDetails.every((file) => {
            if (!file || typeof file !== "object") return false;
            const detail = file as Record<string, unknown>;
            return typeof detail.name === "string" && Number.isFinite(detail.size) && (detail.size as number) >= 0;
        })) {
            console.warn("Ignoring invalid file request details");
            return undefined;
        }
        return {type, fileDetails: payload.fileDetails as TransferFile[]};
    }

    const fileMessageTypes = new Set(["file-start", "file-start-ack", "file-start-reject", "file-end", "file-end-ack", "file-end-reject"]);
    if (fileMessageTypes.has(type)) {
        if (typeof payload.filename !== "string" || !Number.isFinite(payload.size) || (payload.size as number) < 0) {
            console.warn("Ignoring invalid file transfer metadata");
            return undefined;
        }
        return {type, filename: payload.filename, size: payload.size as number} as FileRequest;
    }

    if (type === "file-send-error" && typeof payload.filename === "string") {
        return {type, filename: payload.filename};
    }

    console.warn("Ignoring unknown file transfer message type", type);
    return undefined;
};

const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const fileTypeLabel = (filename: string) => {
    const extension = filename.split(".").pop()?.trim().toUpperCase();
    return extension && extension !== filename.toUpperCase() ? extension.slice(0, 4) : "FILE";
};

export function FileWorkspace({
                                  ref,
                                  palette,
                                  fileChannelSend,
                                  fileChannelSendBytes,
                              }: FileWorkspaceProps) {
    const [fileTransferProgress, setFileTransferProgress] = useState<FileTransferProgress[]>([]);

    const wakeupFileSendingRef = useRef<(() => void) | undefined>(undefined);
    const sendingFilesRef = useRef<TransferFile[]>([]);
    const isInterruptFileSendingRef = useRef(false);
    const dirPickerRef = useRef<ReceiveDirectory | undefined>(undefined);
    const fileHandleRef = useRef<ReceiveFile | undefined>(undefined);
    const isReceivingFileRef = useRef(false);
    const totalChunksRef = useRef(0);
    const chunkIndexRef = useRef(0);
    const interruptFileSendingRef = useRef<(() => void) | undefined>(undefined);
    const [selectedFiles, setSelectedFiles] = useState<TransferFile[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<TransferFile[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSendingFile, setIsSendingFile] = useState(false);
    const [isFileTransferActive, setIsFileTransferActive] = useState(false);


    const onFileChannelReceiveText = async (message: string) => {
        const payload = parseFileRequest(message);
        if (!payload) {
            return;
        }
        const { type } = payload;
        console.log("peer connection payload type", type);
        if (type === "file-request") {
            const { fileDetails } = payload;
            // A previously declined/failed send remains queued for retry. Receiving a
            // new request starts a separate transfer and must clear that stale queue.
            if (!isSendingFile) {
                sendingFilesRef.current = [];
            }
            console.log("Received file requested, fileDetails", fileDetails);
            fileRequestComes(fileDetails);
            initFileProgress(fileDetails);
        } else if (type === "file-request-ack") {
            updateFileTransferStatus("queued");
            const file = sendingFilesRef.current[0];
            if (file) {
                fileChannelSend({ type: "file-start", filename: file.name, size: file.size });
            }
        } else if (type === "file-request-reject") {
            setIsSendingFile(false);
            updateFileTransferStatus("declined");
            console.log("File request declined by the other device");
        } else if (type === "file-start") {
            const { filename, size } = payload;
            try {
                if (!dirPickerRef.current) {
                    showAlert("No receive directory selected");
                    fileChannelSend({ type: "file-start-reject", filename, size });
                    return;
                }
                fileHandleRef.current = await createReceiveFile(dirPickerRef.current, filename);
                isReceivingFileRef.current = true;
                setIsFileTransferActive(true);
                totalChunksRef.current = Math.ceil(size / FILE_CHUNK_SIZE);
                chunkIndexRef.current = 0;
                updateFileTransferProgress(filename, 0, "transferring");
                fileChannelSend({ type: "file-start-ack", filename, size });
            } catch (e) {
                console.error("file-start error", e);
                fileHandleRef.current = undefined;
                isReceivingFileRef.current = false;
                updateFileTransferProgress(filename, 0, "failed");
                fileChannelSend({ type: "file-start-reject", filename, size });
            }
        } else if (type === "file-start-ack") {
            const { filename } = payload;
            const file = sendingFilesRef.current.find((item) => item.name === filename);
            if (!file) {
                return;
            }
            updateFileTransferProgress(filename, 0, "transferring");
            setIsFileTransferActive(true);
            try {
                console.log(`Sending ${filename}`);
                await sendSingleFile(file);
                fileChannelSend({ type: "file-end", filename, size: file.size });
            } catch (e) {
                console.warn("failed to send file, ", filename, e);
                setIsSendingFile(false);
                setIsFileTransferActive(false);
                updateFileTransferProgress(filename, 0, "failed");
                fileChannelSend({ type: "file-send-error", filename });
            }
        } else if (type === "file-continue") {
            wakeupFileSendingRef.current?.();
        } else if (type === "file-abort") {
            interruptFileSendingRef.current?.();
        } else if (type === "file-cancel") {
            await fileAbort();
        } else if (type === "file-end") {
            const { filename, size } = payload;
            try {
                const fileHandle = fileHandleRef.current;
                if (!isReceivingFileRef.current || !fileHandle || fileHandle.name !== filename) {
                    isReceivingFileRef.current = false;
                    fileHandleRef.current = undefined;
                    fileChannelSend({ type: "file-end-reject", filename, size });
                    return;
                }
                const receivedSize = await getFileSize(fileHandle);
                isReceivingFileRef.current = false;
                if (receivedSize === size) {
                    await finalizeReceiveFile(fileHandle);
                    updateFileTransferProgress(filename, size, "completed");
                    setIsFileTransferActive(false);
                    fileChannelSend({ type: "file-end-ack", filename, size });
                    console.log(`Received ${filename}`);
                } else {
                    setIsFileTransferActive(false);
                    updateFileTransferProgress(filename, -1, "failed");
                    fileChannelSend({ type: "file-end-reject", filename, size });
                    console.warn("file is damaged, receivedSize and original size is", filename, receivedSize, size);
                }
                fileHandleRef.current = undefined;
            } catch (e) {
                console.error("exception occurs in file-end process.", e);
                isReceivingFileRef.current = false;
                fileHandleRef.current = undefined;
                setIsFileTransferActive(false);
                updateFileTransferProgress(filename, -1, "failed");
                fileChannelSend({ type: "file-end-reject", filename, size });
            }
        } else if (type === "file-end-ack") {
            const { filename, size } = payload;
            sendingFilesRef.current = sendingFilesRef.current.filter((item) => item.name !== filename);
            updateFileTransferProgress(filename, size, "completed");
            // task completed
            if (sendingFilesRef.current.length === 0) {
                setIsSendingFile(false);
                setIsFileTransferActive(false);
                clearSelectedFiles();
                console.log("File transfer completed");
            } else {
                const file = sendingFilesRef.current[0];
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
            setIsSendingFile(false);
            setIsFileTransferActive(false);
            updateFileTransferProgress(filename, -1, "failed");
        }
    }

    const onFileChannelReceiveBytes = async (bytes: any) => {
        const fileHandle = fileHandleRef.current;
        if (!isReceivingFileRef.current || !fileHandle) {
            return;
        }
        try {
            await appendFileChunk(fileHandle, bytes);
            if (!isReceivingFileRef.current || fileHandleRef.current !== fileHandle) {
                return;
            }
            chunkIndexRef.current += 1;
            if (chunkIndexRef.current % FILE_PROGRESS_CHUNK_INTERVAL === 0) {
                updateFileTransferProgress(fileHandle.name, chunkIndexRef.current * FILE_CHUNK_SIZE, "transferring");
            }
            if (chunkIndexRef.current >= totalChunksRef.current || chunkIndexRef.current % FILE_CHUNK_WINDOW === 0) {
                fileChannelSend({ type: "file-continue" });
            }
        } catch (e) {
            console.error("failed to receive files", e);
            await fileAbort();
        }
    }

    const fileAbort = async () => {
        if (isSendingFile) {
            interruptFileSendingRef.current?.();
            setIsSendingFile(false);
            setIsFileTransferActive(false);
            updateFileTransferStatus("failed");
            fileChannelSend({ type: "file-cancel" });
            return;
        }

        if (isReceivingFileRef.current) {
            const fileHandle = fileHandleRef.current;
            isReceivingFileRef.current = false;
            fileHandleRef.current = undefined;
            setIsFileTransferActive(false);
            updateFileTransferStatus("failed");
            fileChannelSend({ type: "file-abort" });
            if (fileHandle) {
                try {
                    await deleteFile(fileHandle);
                } catch {
                }
            }
        }
    }

    const sendSingleFile = async (file: TransferFile) => {
        isInterruptFileSendingRef.current = false;
        interruptFileSendingRef.current = () => {
            isInterruptFileSendingRef.current = true;
        };
        // File.slice() creates a Blob from a Uint8Array in Expo SDK 57, but
        // React Native's Blob implementation does not support that input.
        // Open explicitly as read-only so both file:// and SAF content:// files work.
        const readHandle = await openFileForReading(file);
        try {
            for (let offset = 0, chunkIndex = 0; offset < file.size;) {
                if (isInterruptFileSendingRef.current) {
                    throw new Error("File transfer aborted");
                }
                const chunk = await readFileChunk(readHandle, FILE_CHUNK_SIZE);
                if (chunk.byteLength === 0) {
                    break;
                }
                await fileChannelSendBytes(chunk);
                offset += chunk.byteLength;
                chunkIndex += 1;
                if (chunkIndex % FILE_PROGRESS_CHUNK_INTERVAL === 0) {
                    updateFileTransferProgress(file.name, offset, "transferring");
                }
                if (offset >= file.size || chunkIndex % FILE_CHUNK_WINDOW === 0) {
                    await new Promise<void>((resolve, reject) => {
                        wakeupFileSendingRef.current = resolve;
                        interruptFileSendingRef.current = () => {
                            isInterruptFileSendingRef.current = true;
                            reject(new Error("File transfer aborted"));
                        };
                    });
                }
            }
        } finally {
            closeFileReader(readHandle);
        }
    };


    const sendFiles = (files: TransferFile[]) => {
        if (files.length === 0) {
            showAlert("No files selected", "Choose at least one file to share.");
            return;
        }
        setIsSendingFile(true);
        setIsFileTransferActive(false);
        sendingFilesRef.current = [...files];
        const fileDetails: TransferFile[] = sendingFilesRef.current.map((file) => {
            return { name: file.name, size: file.size };
        });
        const succ = fileChannelSend({
            type: "file-request",
            fileDetails,
        });
        if (!succ) {
            setIsSendingFile(false);
            showAlert("Unable to send files", "Connect to the other device before sending files.");
            return;
        }
        clearSelectedFiles();
        initFileProgress(fileDetails);
        console.log("Waiting for the other device to approve file transfer");
    };

    const retryRemainingFiles = () => {
        if (isSendingFile || sendingFilesRef.current.length === 0) {
            return;
        }
        sendFiles(sendingFilesRef.current);
    };

    const acceptFiles = async () => {
        const receiveDirectoryUri = storage.get("receive-directory");
        try {
            dirPickerRef.current = receiveDirectoryUri
                ? restoreReceiveDirectory(receiveDirectoryUri)
                : await pickReceiveDirectory();
            updateFileTransferStatus("queued");
            fileChannelSend({ type: "file-request-ack" });
            setReceiveDialogOpen(false);
        } catch (e) {
            console.info("user rejected pickReceiveDirectory.", e);
        }
    };

    const rejectFiles = () => {
        fileChannelSend({ type: "file-request-reject" });
        updateFileTransferStatus("declined");
        setReceiveDialogOpen(false);
    };

    const onFileChannelClose = () => {
        interruptFileSendingRef.current?.();
        const fileHandle = fileHandleRef.current;
        if (isReceivingFileRef.current && fileHandle) {
            void Promise.resolve(deleteFile(fileHandle)).catch(() => undefined);
        }
        isReceivingFileRef.current = false;
        fileHandleRef.current = undefined;
        setIsSendingFile(false);
        setIsFileTransferActive(false);
        updateFileTransferStatus("failed");
    };

    useImperativeHandle(ref, () => ({
        onFileChannelReceiveText,
        onFileChannelReceiveBytes,
        onFileChannelClose,
    }), [onFileChannelReceiveText, onFileChannelReceiveBytes, onFileChannelClose]);

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
        } else {
            setSelectedFiles(result.result);
        }
        sendingFilesRef.current = [];
        setFileTransferProgress([]);
    };

    const clearSelectedFiles = () => {
        setSelectedFiles([]);
    };

    const fileRequestComes = (fileDetails: TransferFile[]) => {
        setIncomingFiles(fileDetails);
        setReceiveDialogOpen(true);
    };

    const initFileProgress = (fileDetails: TransferFile[]) => {
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
                if (fileProgress.name === filename) {
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

    const title = (isSendingFile || sendingFilesRef.current.length > 0) ? "Sending files" : "Receiving files";
    const hasRetryableFiles = !isSendingFile && sendingFilesRef.current.length > 0 && fileTransferProgress.some((file) => file.status === "failed" || file.status === "declined");
    return (
        <>
        <View style={s.toolBlock}>
            <Pressable style={[s.filePicker, { borderColor: palette.border }]} disabled={isSendingFile} onPress={onFilesSelected}>
                <Text style={[s.filePickerTitle, { color: palette.text }]}>
                    {selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected` : "Choose files to share"}
                </Text>
                <Text style={{ color: palette.muted }}>
                    {selectedFiles.length ? selectedFiles.map((file) => `${file.name} (${formatBytes(file.size)})`).join(" · ") : "Any file type. The other device chooses where to save it."}
                </Text>
            </Pressable>
            {fileTransferProgress.length > 0 && (
                <View style={[s.transferTask, { borderColor: palette.border }]}>
                    <View style={s.transferHeader}>
                        <View style={{ flex: 1, gap: 3 }}>
                            <Text style={[s.transferTitle, { color: palette.text }]}>{title}</Text>
                            <Text style={[s.transferCount, { color: palette.muted }]}>
                                {fileTransferProgress.length} file{fileTransferProgress.length === 1 ? "" : "s"} · {formatBytes(fileTransferProgress.reduce((total, file) => total + file.size, 0))}
                            </Text>
                        </View>
                        {isFileTransferActive && <Pressable style={s.secondary} onPress={fileAbort}>
                            <Text style={s.secondaryText}>Stop</Text>
                        </Pressable>}
                    </View>
                    {fileTransferProgress.map((file, index) => {
                        const percent = file.size === 0 ? 100 : Math.round((file.transferred / file.size) * 100);
                        return <View key={file.name} style={[s.transferFile, index < fileTransferProgress.length - 1 && { borderBottomWidth: 1, borderBottomColor: palette.border, paddingBottom: 12 }]}>
                            <View style={s.transferFileRow}>
                                <View style={[s.transferFileBadge, { backgroundColor: file.status === "failed" ? "#f9d9d7" : file.status === "completed" ? "#d9f2e3" : "#e7efff" }]}>
                                    <Text style={[s.transferFileBadgeText, { color: file.status === "failed" ? "#a52a25" : file.status === "completed" ? "#187044" : "#2456b8" }]}>{fileTypeLabel(file.name)}</Text>
                                </View>
                                <View style={s.transferFileInfo}>
                                    <View style={s.transferSummary}>
                                        <Text numberOfLines={1} style={[s.transferName, { color: palette.text }]}>{file.name}</Text>
                                        <Text style={[s.transferStatus, transferStatusColors[file.status]]}>{transferStatusLabel[file.status]}</Text>
                                    </View>
                                    <Text style={[s.transferMeta, { color: palette.muted }]}>
                                        {file.status === "transferring" ? `${formatBytes(Math.max(0, file.transferred))} of ${formatBytes(file.size)} · ${Math.max(0, Math.min(percent, 100))}%` : formatBytes(file.size)}
                                    </Text>
                                </View>
                            </View>
                            {(file.status === "transferring" || file.status === "completed") && <View style={[s.progressTrack, { backgroundColor: palette.border }]}><View style={[s.progressValue, { width: `${Math.max(0, Math.min(percent, 100))}%`, backgroundColor: file.status === "completed" ? "#2f9e68" : "#2f6fed" }]} /></View>}
                        </View>;
                    })}
                </View>
            )}
            <View style={s.footer}>
                <Text style={{ color: palette.muted }}>{selectedFiles.length ? `${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))} ready` : "No files selected"}</Text>
                {hasRetryableFiles ? (
                    <Pressable style={s.primary} onPress={retryRemainingFiles}>
                        <Text style={s.primaryText}>Retry remaining</Text>
                    </Pressable>
                ) : (
                    <Pressable style={[s.primary, (!selectedFiles.length || isSendingFile) && s.disabled]} disabled={!selectedFiles.length || isSendingFile} onPress={() => { sendFiles(selectedFiles) }}>
                        <Text style={s.primaryText}>{isSendingFile ? "Awaiting approval" : "Send files"}</Text>
                    </Pressable>
                )}
            </View>
        </View>
        <Modal transparent visible={isReceiveDialogOpen} animationType="fade" onRequestClose={rejectFiles}>
            <View style={s.modalBackdrop}>
                <View style={[s.dialog, { backgroundColor: palette.card, borderColor: palette.border }]}>
                    <Text style={[s.heading, { color: palette.text }]}>Incoming files</Text>
                    <Text style={{ color: palette.muted }}>The paired device wants to send {incomingFiles.length} file{incomingFiles.length <= 1 ? "" : "s"}.</Text>
                    {incomingFiles.map((file) => (
                        <View style={s.incomingFile} key={file.name}>
                            <Text style={{ color: palette.text }}>{file.name}</Text>
                            <Text style={{ color: palette.muted }}>{formatBytes(file.size)}</Text>
                        </View>
                    ))}
                    <View style={s.footer}>
                        <Pressable style={s.secondary} onPress={rejectFiles}><Text style={s.secondaryText}>Decline</Text></Pressable>
                        <Pressable style={s.primary} onPress={() => void acceptFiles()}><Text style={s.primaryText}>Choose folder & receive</Text></Pressable>
                    </View>
                </View>
            </View>
        </Modal>
        </>
    );
}
