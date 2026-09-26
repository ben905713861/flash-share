import { invoke } from "@tauri-apps/api/core";

const isImageFile = (file: TransferFile) => {
    return file.type.startsWith("image/") || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name);
};

const isVideoFile = (file: TransferFile) => {
    return file.type.startsWith("video/") || /\.(3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|webm|wmv)$/i.test(file.name);
};

// upload files
export type FileReader = {
    file: TransferFile;
    offset: number;
};

export type TransferFile = File;

export const pickTransferFiles = async (): Promise<{canceled: false; result: TransferFile[]} | {canceled: true; result: null}> => {
    throw new Error("pickTransferFiles in web model is not supported");
};

export const openFileForReading = (file: TransferFile): FileReader => {
    return {file, offset: 0};
};

export const readFileChunk = async (reader: FileReader, size: number) => {
    const blob = reader.file.slice(reader.offset, reader.offset + size);
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    reader.offset += bytes.byteLength;
    return bytes;
};

export const closeFileReader = (reader: FileReader) => {
    void reader;
};

// thumb
export const createTransferFilePreviewUri = async (file: TransferFile) => {
    if (isImageFile(file)) {
        return URL.createObjectURL(file);
    }
    if (isVideoFile(file)) {
        const sourceVideoUri = URL.createObjectURL(file);
        try {
            return await createVideoThumb(sourceVideoUri);
        } finally {
            URL.revokeObjectURL(sourceVideoUri);
        }
    }
    async function createVideoThumb(sourceUri: string) {
        return await new Promise<string>((resolve, reject) => {
            const video = document.createElement("video");
            video.preload = "auto";
            video.muted = true;
            video.playsInline = true;
            let captured = false;
            const capture = () => {
                if (captured) return;
                captured = true;
                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const context = canvas.getContext("2d");
                if (!context || canvas.width === 0 || canvas.height === 0) {
                    reject(new Error("Unable to decode video frame"));
                    return;
                }
                setTimeout(() => {
                    context.drawImage(video, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob((blob) => {
                        if (blob) {
                            resolve(URL.createObjectURL(blob));
                        } else {
                            reject(new Error("Unable to encode video preview"));
                        }
                    }, "image/jpeg", 0.85);
                }, 1);

            };
            video.onloadedmetadata = () => {
                video.currentTime = video.duration > 0 ? Math.min(0.1, video.duration) : 0;
            };
            video.onloadeddata = capture;
            video.onseeked = capture;
            video.onerror = () => reject(new Error("Unable to load video preview"));
            video.src = sourceUri;
            video.load();
        });
    }
    return null;
};

export const releaseTransferFilePreviewUri = (uri: string) => {
    URL.revokeObjectURL(uri);
};

// setting model
export type ReceiveDirectory = {
    path?: string;
};

export const getReceiveDirectoryUri = (directory: ReceiveDirectory) => {
    return directory.path ?? "";
};

export const restoreReceiveDirectory = (uri: string): ReceiveDirectory => {
    return {path: uri};
};

// download files
export type ReceiveFile = {
    name: string;
    chunks: Uint8Array[];
    size: number;
    directory: ReceiveDirectory;
};

export const pickReceiveDirectory = async (): Promise<ReceiveDirectory> => {
    const path = await invoke<string | null>("pick_receive_directory");
    console.log("path is", path);
    if (!path) {
        console.log("No receive directory selected");
        return Promise.reject(new Error("No receive directory selected"));
    }
    return {path};
};

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
