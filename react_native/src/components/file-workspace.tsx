import { Modal, Pressable, Text, View } from "react-native";
import type { FileDetail, FileTransferProgress, FileTransferStatus } from "@/lib/webrtc";
import { C, s } from "@/styles";
import React, {useImperativeHandle, useState} from "react";

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
    type ReceiveDirectory,
    type ReceiveFile,
    type TransferFile,
} from "@/lib/file-transfer";
import {showAlert} from "@/components/alert-modal";

const FILE_CHUNK_SIZE = 256 * 1024;
const FILE_CHUNK_WINDOW = 16;
const FILE_PROGRESS_CHUNK_INTERVAL = 4;
const FILE_BUFFER_LOW_WATER_MARK = 1 * 1024 * 1024;

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

export interface FileWorkspaceRef {
    onFileChannelReceiveText: (message: string) => Promise<void>;
    onFileChannelReceiveBytes:  (bytes: any) => Promise<void>;
    onFileChannelClose: () => void,
}

const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export function FileWorkspace({
                                  ref,
                                  palette,
                                  // onSelectFiles,
                                  // onSendFiles,
                                  // onAcceptFiles,
                                  // onRejectFiles,
                                  fileChannelSend,
                                  fileChannelSendBytes,
                                }: FileWorkspaceProps) {
    const [fileTransferProgress, setFileTransferProgress] = useState<FileTransferProgress[]>([]);


    let wakeupFileSending: (() => void) | undefined;
    let sendingFiles: TransferFile[] = [];
    let isInterruptFileSending = false;
    let dirPicker: ReceiveDirectory | undefined;
    let writable: ReceiveFile | undefined;
    let fileHandle: ReceiveFile | undefined;
    let chunkIndex = 0;
    let interruptFileSending: (() => void) | undefined;
    const [selectedFiles, setSelectedFiles] = useState<TransferFile[]>([]);
    const [incomingFiles, setIncomingFiles] = useState<FileDetail[]>([]);
    const [isReceiveDialogOpen, setReceiveDialogOpen] = useState(false);
    const [isSendingFile, setIsSendingFile] = useState(false);


    const onFileChannelReceiveText = async (message: string) => {
        let payload: FileRequest;
        try {
            payload = JSON.parse(message) as FileRequest;
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
            console.log("File request declined by the other device");
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
                console.log(`Sending ${filename}`);
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
                    console.log(`Received ${filename}`);
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
                console.log("File transfer completed");
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
    }

    const onFileChannelReceiveBytes = async (bytes: any) => {
        if (!writable) {
            return;
        }
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

    useImperativeHandle(ref, () => ({
        onFileChannelReceiveText,
        onFileChannelReceiveBytes,
        onFileChannelClose,
    }), []);

    const sendSingleFile = async (file: TransferFile) => {
        isInterruptFileSending = false;
        interruptFileSending = () => {
            isInterruptFileSending = true;
        };
        // File.slice() creates a Blob from a Uint8Array in Expo SDK 57, but
        // React Native's Blob implementation does not support that input.
        // Open explicitly as read-only so both file:// and SAF content:// files work.
        const readHandle = await openFileForReading(file);
        try {
            for (let offset = 0, chunkIndex = 0; offset < file.size;) {
                if (isInterruptFileSending) {
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


    const sendFiles = (files: TransferFile[]) => {
        setIsSendingFile(true);
        if (files.length === 0) {
            setIsSendingFile(false);
            throw new Error("no file is selected");
        }
        sendingFiles = [...files];
        const fileDetails: FileDetail[] = sendingFiles.map((file) => {
            return { filename: file.name, size: file.size };
        });
        const succ = fileChannelSend({
            type: "file-request",
            fileDetails,
        });
        if (!succ) {
            setIsSendingFile(false);
            throw new Error("failed to send files");
        }
        initFileProgress(fileDetails);
        console.log("Waiting for the other device to approve file transfer");
    };

    const acceptFiles = async () => {
        try {
            dirPicker = await pickReceiveDirectory();
            updateFileTransferStatus("queued");
            fileChannelSend({ type: "file-request-ack" });
            setReceiveDialogOpen(false);
        } catch {
            updateFileTransferStatus("declined");
            fileChannelSend({ type: "file-request-reject" });
        }
    };

    const rejectFiles = () => {
        fileChannelSend({ type: "file-request-reject" });
        updateFileTransferStatus("declined");
        setReceiveDialogOpen(false);
    };

    const onFileChannelClose = () => {
        interruptFileSending?.();
        setIsSendingFile(false);
        updateFileTransferStatus("failed");
    };

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
            return;
        }
        setSelectedFiles(result.result);
    };

    const clearSelectedFiles = () => {
        setSelectedFiles([]);
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




    const title = selectedFiles.length > 0 ? "Sending files" : "Receiving files";
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
                    <Text style={[s.transferTitle, { color: palette.text }]}>{title}</Text>
                    {fileTransferProgress.map((file) => {
                        const percent = file.size === 0 ? 100 : Math.round((file.transferred / file.size) * 100);
                        return <View key={file.filename} style={s.transferFile}>
                            <View style={s.transferSummary}>
                                <Text numberOfLines={1} style={[s.transferName, { color: palette.text }]}>{file.filename}</Text>
                                <Text style={[s.transferStatus, transferStatusColors[file.status]]}>{transferStatusLabel[file.status]}</Text>
                            </View>
                            {(file.status === "transferring" || file.status === "completed") && <>
                                {file.status === "transferring" && <View style={s.progressTrack}><View style={[s.progressValue, { width: `${Math.max(0, Math.min(percent, 100))}%` }]} /></View>}
                                <Text style={{ color: palette.muted }}>{`${formatBytes(file.transferred)} of ${formatBytes(file.size)} (${percent}%)`}</Text>
                            </>}
                        </View>;
                    })}
                </View>
            )}
            <View style={s.footer}>
                <Text style={{ color: palette.muted }}>{selectedFiles.length ? `${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))} ready` : "No files selected"}</Text>
                <Pressable style={[s.primary, (!selectedFiles.length || isSendingFile) && s.disabled]} disabled={!selectedFiles.length || isSendingFile} onPress={() => { sendFiles(selectedFiles) }}>
                    <Text style={s.primaryText}>{isSendingFile ? "Awaiting approval" : "Send files"}</Text>
                </Pressable>
            </View>
        </View>
        <Modal transparent visible={isReceiveDialogOpen} animationType="fade" onRequestClose={rejectFiles}>
            <View style={s.modalBackdrop}>
                <View style={[s.dialog, { backgroundColor: palette.card, borderColor: palette.border }]}>
                    <Text style={[s.heading, { color: palette.text }]}>Incoming files</Text>
                    <Text style={{ color: palette.muted }}>The paired device wants to send {incomingFiles.length} file{incomingFiles.length <= 1 ? "" : "s"}.</Text>
                    {incomingFiles.map((file) => (
                        <View style={s.incomingFile} key={file.filename}>
                            <Text style={{ color: palette.text }}>{file.filename}</Text>
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
