import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type TransferFile = File;

export const createTransferFilePreviewUri = (file: TransferFile) => URL.createObjectURL(file);

export const releaseTransferFilePreviewUri = (uri: string) => URL.revokeObjectURL(uri);

export const pickTransferFiles = async (): Promise<{canceled: false; result: TransferFile[]} | {canceled: true; result: null}> => {
    throw new Error("pickTransferFiles in web model is not supported");
};

export type ReceiveDirectory = {
    path?: string;
};

export type FileReader = {
    file: TransferFile;
    offset: number;
};

export type ReceiveFile = {
    name: string;
    chunks: Uint8Array[];
    size: number;
    directory: ReceiveDirectory;
};

export const openFileForReading = (file: TransferFile): FileReader => ({file, offset: 0});

export const readFileChunk = async (reader: FileReader, size: number) => {
    const bytes = new Uint8Array(await reader.file.slice(reader.offset, reader.offset + size).arrayBuffer());
    reader.offset += bytes.byteLength;
    return bytes;
};

export const closeFileReader = (_reader: FileReader) => undefined;

export const pickReceiveDirectory = async (): Promise<ReceiveDirectory> => {
    const path = await invoke<string | null>("pick_receive_directory");
    console.log("path is", path);
    if (!path) {
        console.log("No receive directory selected");
        return Promise.reject(new Error("No receive directory selected"));
    }
    return {path};
};

export const getReceiveDirectoryUri = (directory: ReceiveDirectory) => directory.path ?? "";

export const restoreReceiveDirectory = (uri: string): ReceiveDirectory => ({path: uri});

export const createReceiveFile = async (directory: ReceiveDirectory, filename: string): Promise<ReceiveFile> => {
    await invoke("open_receive_file", {
        directory: directory.path,
        filename,
    });
    return {
        name: filename,
        chunks: [],
        size: 0,
        directory,
    };
};

export const appendFileChunk = async (file: ReceiveFile, bytes: Uint8Array) => {
    await invoke("append_receive_file", {
        directory: file.directory.path,
        filename: file.name,
        bytes: Array.from(bytes),
    });
    file.size += bytes.byteLength;
};

export const getFileSize = (file: ReceiveFile) => file.size;

export const finalizeReceiveFile = async (file: ReceiveFile) => {
    await invoke("close_receive_file", {
        directory: file.directory.path,
        filename: file.name,
    });
};

export const deleteFile = async (file: ReceiveFile) => {
    await invoke("delete_receive_file", {directory: file.directory.path, filename: file.name});
};
