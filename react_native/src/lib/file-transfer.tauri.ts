import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/tauri";

export type TransferFile = File;

export const pickTransferFiles = (): Promise<{canceled: false; result: TransferFile[]} | {canceled: true; result: null}> => {
    return new Promise((resolve) => {
        console.log("tauri");
        resolve({canceled: false, result: []});
    });
};

type WebDirectoryHandle = {
    requestPermission: (options: {mode: "read" | "readwrite"}) => Promise<"granted" | "denied">;
    getFileHandle: (name: string, options: {create: boolean}) => Promise<WebFileHandle>;
};

type WebFileHandle = {
    createWritable: () => Promise<WebWritableFileStream>;
};

type WebWritableFileStream = {
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
};

type DirectoryPickerGlobal = typeof globalThis & {
    showDirectoryPicker?: (options?: {mode?: "read" | "readwrite"}) => Promise<WebDirectoryHandle>;
};

export type ReceiveDirectory = {
    handle?: WebDirectoryHandle;
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
    isTauriFile: boolean;
};

export const openFileForReading = (file: TransferFile): FileReader => ({file, offset: 0});

export const readFileChunk = async (reader: FileReader, size: number) => {
    const bytes = new Uint8Array(await reader.file.slice(reader.offset, reader.offset + size).arrayBuffer());
    reader.offset += bytes.byteLength;
    return bytes;
};

export const closeFileReader = (_reader: FileReader) => undefined;

export const pickReceiveDirectory = async (): Promise<ReceiveDirectory> => {
    if (isTauri()) {
        const path = await invoke<string | null>("pick_receive_directory");
        console.log("path is", path);
        if (!path) {
            console.log("No receive directory selected");
            return Promise.reject(new Error("No receive directory selected"));
        }
        return {path};
    }
    const picker = (globalThis as DirectoryPickerGlobal).showDirectoryPicker;
    if (!picker) {
        throw new Error("Directory access is not supported in this browser");
    }
    const handle = await picker({mode: "readwrite"});
    const permission = await handle.requestPermission({mode: "readwrite"});
    if (permission !== "granted") {
        throw new Error("Write permission for the receive directory was denied");
    }
    return {handle};
};

export const getReceiveDirectoryUri = (directory: ReceiveDirectory) => directory.path ?? "";

export const restoreReceiveDirectory = (uri: string): ReceiveDirectory => ({path: uri});

export const createReceiveFile = async (directory: ReceiveDirectory, filename: string): Promise<ReceiveFile> => {
    if (directory.path) {
        await invoke("open_receive_file", {
            directory: directory.path,
            filename,
        });
    }
    return {
        name: filename,
        chunks: [],
        size: 0,
        directory,
        isTauriFile: Boolean(directory.path),
    };
};

export const appendFileChunk = async (file: ReceiveFile, bytes: Uint8Array) => {
    if (isTauri()) {
        await invoke("append_receive_file", {
            directory: file.directory.path,
            filename: file.name,
            bytes: Array.from(bytes),
        });
        file.size += bytes.byteLength;
        return;
    }
    file.chunks.push(bytes);
    file.size += bytes.byteLength;
};

export const getFileSize = (file: ReceiveFile) => file.size;

export const finalizeReceiveFile = async (file: ReceiveFile) => {
    if (file.isTauriFile && file.directory.path) {
        await invoke("close_receive_file", {
            directory: file.directory.path,
            filename: file.name,
        });
        return;
    }
    const blob = new Blob(file.chunks.map((chunk) => Uint8Array.from(chunk)));
    if (file.directory.handle) {
        const handle = await file.directory.handle.getFileHandle(file.name, {create: true});
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
    }

    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
};

export const deleteFile = async (file: ReceiveFile) => {
    if (file.isTauriFile && file.directory.path) {
        await invoke("delete_receive_file", {directory: file.directory.path, filename: file.name});
    }
};
