import {Directory, File, FileMode, Paths} from "expo-file-system";

export type TransferFile = File;
export type ReceiveDirectory = Directory;
export type ReceiveFile = File;
export type FileReader = ReturnType<File["open"]>;

export const pickTransferFiles = async (): Promise<{canceled: false; result: TransferFile[]} | {canceled: true; result: null}> => {
    return File.pickFileAsync({multipleFiles: true});
};

export const openFileForReading = async (file: TransferFile): Promise<FileReader> => {
    // 1. 创建 Cache 中的目标文件
    const cacheFile = new File(
        Paths.cache,
        `webrtc-${Date.now()}-${file.name}`
    );

    // 2. 把 content:// 文件复制到 App Cache
    await file.copy(cacheFile);

    return cacheFile.open(FileMode.ReadOnly);
}

export const readFileChunk = (reader: FileReader, size: number) => reader.readBytes(size);

export const closeFileReader = (reader: FileReader) => {
    reader.close();
};

export const pickReceiveDirectory = () => Directory.pickDirectoryAsync();

export const createReceiveFile = (directory: ReceiveDirectory, filename: string): ReceiveFile => {
    const existingFile = directory.list().find(file => {
        return file.name === filename;
    });
    if (existingFile) {
        existingFile.delete();
    }
    // SAF content:// URIs must be created through their parent directory.
    return directory.createFile(filename, "application/octet-stream");
};

export const appendFileChunk = (file: ReceiveFile, bytes: Uint8Array) => {
    file.write(bytes, {append: true});
};

export const getFileSize = (file: ReceiveFile) => file.info().size;

export const finalizeReceiveFile = async (_file: ReceiveFile) => undefined;

export const deleteFile = (file: ReceiveFile) => {
    file.delete();
};
