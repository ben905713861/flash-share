export type TransferFile = File;

export const pickTransferFiles = (): Promise<{canceled: false; result: TransferFile[]} | {canceled: true; result: null}> => {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.onchange = () => {
            resolve(input.files
                ? {canceled: false, result: Array.from(input.files)}
                : {canceled: true, result: null});
        };
        input.click();
    });
};

type WebDirectoryHandle = {
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
    showDirectoryPicker?: () => Promise<WebDirectoryHandle>;
};

export type ReceiveDirectory = {
    handle?: WebDirectoryHandle;
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
    const handle = await (globalThis as DirectoryPickerGlobal).showDirectoryPicker?.();
    return {handle};
};

export const createReceiveFile = (directory: ReceiveDirectory, filename: string): ReceiveFile => ({
    name: filename,
    chunks: [],
    size: 0,
    directory,
});

export const appendFileChunk = (file: ReceiveFile, bytes: Uint8Array) => {
    file.chunks.push(bytes);
    file.size += bytes.byteLength;
};

export const getFileSize = (file: ReceiveFile) => file.size;

export const finalizeReceiveFile = async (file: ReceiveFile) => {
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

export const deleteFile = (_file: ReceiveFile) => undefined;
