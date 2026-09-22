import React from "react";
import {useDropzone} from "react-dropzone";
import {StyleSheet} from "react-native";
import type {FileDropZoneProps} from "./file-drop-zone";

export function FileDropZone({children, style, activeStyle, disabled, onFilesSelected}: FileDropZoneProps) {
    const {getRootProps, getInputProps, isDragActive} = useDropzone({
        disabled,
        multiple: true,
        onDrop: onFilesSelected,
    });
    const baseStyle = StyleSheet.flatten(style) as React.CSSProperties | undefined;
    const highlightedStyle = StyleSheet.flatten(activeStyle) as React.CSSProperties | undefined;

    return (
        <div
            {...getRootProps({
                style: {...baseStyle, ...(isDragActive ? highlightedStyle : undefined)},
            })}
        >
            <input {...getInputProps()} />
            {children}
        </div>
    );
}
