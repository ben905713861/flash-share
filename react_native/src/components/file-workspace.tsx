import { Modal, Pressable, Text, View } from "react-native";
import type { TransferFile } from "@/lib/file-transfer";
import type { FileDetail, FileTransferProgress, FileTransferStatus } from "@/lib/webrtc";
import { C, s } from "@/styles";

type FileWorkspaceProps = {
    selectedFiles: TransferFile[];
    isSendingFile: boolean;
    fileTransferProgress: FileTransferProgress[];
    palette: (typeof C)["light"];
    onSelectFiles: () => void;
    onSendFiles: () => void;
    incomingFiles: FileDetail[];
    isReceiveDialogOpen: boolean;
    onAcceptFiles: () => Promise<void>;
    onRejectFiles: () => void;
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

const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export function FileWorkspace({ selectedFiles, isSendingFile, fileTransferProgress, palette, onSelectFiles, onSendFiles, incomingFiles, isReceiveDialogOpen, onAcceptFiles, onRejectFiles }: FileWorkspaceProps) {
    const title = selectedFiles.length > 0 ? "Sending files" : "Receiving files";
    return (
        <>
        <View style={s.toolBlock}>
            <Pressable style={[s.filePicker, { borderColor: palette.border }]} disabled={isSendingFile} onPress={onSelectFiles}>
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
                <Pressable style={[s.primary, (!selectedFiles.length || isSendingFile) && s.disabled]} disabled={!selectedFiles.length || isSendingFile} onPress={onSendFiles}>
                    <Text style={s.primaryText}>{isSendingFile ? "Awaiting approval" : "Send files"}</Text>
                </Pressable>
            </View>
        </View>
        <Modal transparent visible={isReceiveDialogOpen} animationType="fade" onRequestClose={onRejectFiles}>
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
                        <Pressable style={s.secondary} onPress={onRejectFiles}><Text style={s.secondaryText}>Decline</Text></Pressable>
                        <Pressable style={s.primary} onPress={() => void onAcceptFiles()}><Text style={s.primaryText}>Choose folder & receive</Text></Pressable>
                    </View>
                </View>
            </View>
        </Modal>
        </>
    );
}
