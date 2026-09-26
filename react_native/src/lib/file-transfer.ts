export type TransferFile = {
    name: string;
    size: number;
    thumb?: string;
};

export type ReceiveDirectory = unknown;
export type ReceiveFile = {
    name: string;
};
export type FileReader = unknown;
export type FilePickerResult =
    | {canceled: false; result: TransferFile[]}
    | {canceled: true; result: null};

// upload files
export declare const pickTransferFiles: () => Promise<FilePickerResult>;
export declare const openFileForReading: (file: TransferFile) => Promise<FileReader>;
export declare const readFileChunk: (reader: FileReader, size: number) => Uint8Array | Promise<Uint8Array>;
export declare const closeFileReader: (reader: FileReader) => void;

// thumb
export declare const createTransferFilePreviewUri: (file: TransferFile) => Promise<string>;
export declare const releaseTransferFilePreviewUri: (uri: string) => void;

// setting model
export declare const getReceiveDirectoryUri: (directory: ReceiveDirectory) => string;
export declare const restoreReceiveDirectory: (uri: string) => ReceiveDirectory;

// download files
export declare const pickReceiveDirectory: () => Promise<ReceiveDirectory>;
export declare const createReceiveFile: (directory: ReceiveDirectory, filename: string) => Promise<ReceiveFile>;
export declare const appendFileChunk: (file: ReceiveFile, bytes: Uint8Array) => void | Promise<void>;
export declare const getFileSize: (file: ReceiveFile) => number | Promise<number>;
export declare const finalizeReceiveFile: (file: ReceiveFile) => void | Promise<void>;
export declare const deleteFile: (file: ReceiveFile) => void | Promise<void>;
