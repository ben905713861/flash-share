import {Pressable, type StyleProp, type ViewStyle} from "react-native";
import {
    pickTransferFiles,
    type TransferFile
} from "@/lib/file-transfer";
import React, {useEffect} from "react";
import {showAlert} from "@/components/alert-modal";
import {useShareIntentContext} from "expo-share-intent";
import {File} from "expo-file-system";

export type FileDropZoneProps = {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    activeStyle?: StyleProp<ViewStyle>;
    disabled?: boolean;
    onFilesSelected: (files: TransferFile[]) => void;
};

export function FileDropZone({children, style, disabled, onFilesSelected}: FileDropZoneProps) {
    const {hasShareIntent, shareIntent, resetShareIntent, error: shareIntentError} = useShareIntentContext();

    const selectFiles = async () => {
        const result = await pickTransferFiles();
        if (result.canceled) {
            return;
        }
        const acceptedFiles: TransferFile[] = result.result;
        onFilesSelected(acceptedFiles);
    };

    useEffect(() => {
        if (shareIntentError) {
            showAlert("Unable to receive shared files", shareIntentError);
        }
    }, [shareIntentError]);

    useEffect(() => {
        // Keep the native share intent pending while a transfer is active.
        // The effect runs again when the workspace becomes available.
        if (disabled || !hasShareIntent || !shareIntent.files || shareIntent.files.length <= 0) {
            return;
        }
        const files = shareIntent.files
            .filter((file) => typeof file.path === "string" && file.path.length > 0)
            .map((file) => new File(file.path));
        if (files.length <= 0) {
            showAlert("Unable to receive shared files", "The shared files did not include a readable file path.");
            resetShareIntent(true);
            return;
        }
        onFilesSelected(files);
        resetShareIntent(true);
    }, [disabled, hasShareIntent, shareIntent.files, resetShareIntent]);

    return <Pressable style={style} disabled={disabled} onPress={() => void selectFiles()}>{children}</Pressable>;
}
