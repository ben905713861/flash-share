import { Pressable, Text, View } from "react-native";
import type { TransferFile } from "@/lib/file-transfer";
import type { FileTransferProgress, FileTransferStatus } from "@/lib/webrtc";
import { C, s } from "@/styles";

type FileWorkspaceProps = {
    selectedFiles: TransferFile[];
    isSendingFile: boolean;
    fileTransferProgress: FileTransferProgress[];
    palette: (typeof C)["light"];
    onSelectFiles: () => void;
    onSendFiles: () => void;
};

const transferStatusLabel: Record<FileTransferStatus, string> = {
    awaiting_approval: "Awaiting approval", queued: "Queued", transferring: "Transferring",
    completed: "Completed", declined: "Declined", failed: "Failed",
};

const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export function FileWorkspace({ selectedFiles, isSendingFile, fileTransferProgress, palette, onSelectFiles, onSendFiles }: FileWorkspaceProps) {
    const title = selectedFiles.length > 0 ? "Sending files" : "Receiving files";
    return (
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
                                <Text style={{ color: palette.muted }}>{formatBytes(file.size)}</Text>
                                <Text style={[s.transferStatus, { color: palette.muted }]}>{transferStatusLabel[file.status]}</Text>
                            </View>
                            {(file.status === "transferring" || file.status === "completed") && <>
                                <View style={s.progressTrack}><View style={[s.progressValue, { width: `${Math.max(0, Math.min(percent, 100))}%` }]} /></View>
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
    );
}
