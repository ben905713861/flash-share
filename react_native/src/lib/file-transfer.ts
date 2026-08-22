export type TransferFile = {
    name: string;
    size: number;
};

export type ReceiveDirectory = unknown;
export type ReceiveFile = {
    name: string;
};
export type FileReader = unknown;
export type FilePickerResult =
    | {canceled: false; result: TransferFile[]}
    | {canceled: true; result: null};

export declare const pickTransferFiles: () => Promise<FilePickerResult>;
export declare const openFileForReading: (file: TransferFile) => FileReader;
export declare const readFileChunk: (reader: FileReader, size: number) => Uint8Array | Promise<Uint8Array>;
export declare const closeFileReader: (reader: FileReader) => void;
export declare const pickReceiveDirectory: () => Promise<ReceiveDirectory>;
export declare const createReceiveFile: (directory: ReceiveDirectory, filename: string) => ReceiveFile;
export declare const appendFileChunk: (file: ReceiveFile, bytes: Uint8Array) => void | Promise<void>;
export declare const getFileSize: (file: ReceiveFile) => number | Promise<number>;
export declare const finalizeReceiveFile: (file: ReceiveFile) => void | Promise<void>;
export declare const deleteFile: (file: ReceiveFile) => void | Promise<void>;
