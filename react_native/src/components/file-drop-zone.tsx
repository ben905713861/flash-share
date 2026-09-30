import {type StyleProp, type ViewStyle} from "react-native";
import {
    type TransferFile
} from "@/lib/file-transfer";
import React, {JSX} from "react";

export type FileDropZoneProps = {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    activeStyle?: StyleProp<ViewStyle>;
    disabled?: boolean;
    onFilesSelected: (files: TransferFile[]) => void;
};

export declare function FileDropZone({children, style, disabled, onFilesSelected}: FileDropZoneProps): JSX.Element;
