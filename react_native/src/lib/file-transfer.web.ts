
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

export const createReceiveFilePreviewUri = async (file: ReceiveFile) => {
    return createTransferFilePreviewUri(await file.handle.getFile());
};

export const releaseTransferFilePreviewUri = (uri: string) => {
    URL.revokeObjectURL(uri);
};


// setting model
export type ReceiveDirectory = {
    handle: FileSystemDirectoryHandle;
};

type PermissionAwareDirectoryHandle = FileSystemDirectoryHandle & {
    requestPermission(options: {mode: "read" | "readwrite"}): Promise<"granted" | "denied" | "prompt">;
};

export const getReceiveDirectoryUri = (directory: ReceiveDirectory) => {
    return "";
};

export const restoreReceiveDirectory = (uri: string): ReceiveDirectory => {
    throw new Error("Restore directory was denied");
};

// download files
type DirectoryPickerGlobal = typeof globalThis & {
    showDirectoryPicker?: (options?: {mode?: "read" | "readwrite"}) => Promise<FileSystemDirectoryHandle>;
};

export type ReceiveFile = {
    name: string;
    size: number;
    directory: ReceiveDirectory;
    handle: FileSystemFileHandle;
    writable: FileSystemWritableFileStream;
};

export const pickReceiveDirectory = async (): Promise<ReceiveDirectory> => {
    const picker = (globalThis as DirectoryPickerGlobal).showDirectoryPicker;
    if (!picker) {
        throw new Error("Directory access is not supported in this browser");
    }
    const handle = await picker({mode: "readwrite"});
    const permission = await (handle as PermissionAwareDirectoryHandle).requestPermission({mode: "readwrite"});
    if (permission !== "granted") {
        throw new Error("Write permission for the receive directory was denied");
    }
    return {handle};
};

export const createReceiveFile = async (directory: ReceiveDirectory, filename: string): Promise<ReceiveFile> => {
    const handle = await directory.handle.getFileHandle(filename, {create: true});
    const writable = await handle.createWritable();
    return {
        name: filename,
        size: 0,
        directory,
        handle,
        writable,
    };
};

export const appendFileChunk = async (file: ReceiveFile, bytes: Uint8Array) => {
    const chunk = new Uint8Array(bytes.byteLength);
    chunk.set(bytes);
    await file.writable.write(chunk);
    file.size += bytes.byteLength;
};

export const getFileSize = (file: ReceiveFile) => {
    return file.size;
};

export const finalizeReceiveFile = async (file: ReceiveFile) => {
    await file.writable.close();
};

export const deleteFile = async (file: ReceiveFile) => {
    try {
        await file.writable.abort();
    } finally {
        await file.directory.handle.removeEntry(file.name);
    }
};
