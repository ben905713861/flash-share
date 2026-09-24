import {Pressable, type StyleProp, type ViewStyle} from "react-native";
import {pickTransferFiles, type TransferFile} from "@/lib/file-transfer";

export type FileDropZoneProps = {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    activeStyle?: StyleProp<ViewStyle>;
    disabled?: boolean;
    onFilesSelected: (files: TransferFile[]) => void;
};

export function FileDropZone({children, style, disabled, onFilesSelected}: FileDropZoneProps) {
    const selectFiles = async () => {
        const result = await pickTransferFiles();
        if (result.canceled) {
            return;
        }
        const acceptedFiles: TransferFile[] = result.result;
        onFilesSelected(acceptedFiles);
    };

    return <Pressable style={style} disabled={disabled} onPress={() => void selectFiles()}>{children}</Pressable>;
}
