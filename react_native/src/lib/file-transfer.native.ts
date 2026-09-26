import {Directory, File, FileMode, Paths} from "expo-file-system";
import * as VideoThumbnails from "expo-video-thumbnails";
import NativeFileReaderModule from "../../modules/native-file-reader/src/NativeFileReaderModule";

export type TransferFile = File;
export type ReceiveDirectory = Directory;
export type ReceiveFile = File;
export type FileReader = string;

export const createTransferFilePreviewUri = async (file: TransferFile) => {
    const mimeType = "type" in file && typeof file.type === "string" ? file.type : "";
    const isVideo = mimeType.startsWith("video/") || /\.(3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|webm|wmv)$/i.test(file.name);
    if (!isVideo) {
        return file.uri;
    }
    const thumbnail = await VideoThumbnails.getThumbnailAsync(file.uri, {time: 0});
    return thumbnail.uri;
};

export const releaseTransferFilePreviewUri = (_uri: string) => undefined;

export const pickTransferFiles = async (): Promise<{canceled: false; result: TransferFile[]} | {canceled: true; result: null}> => {
    return File.pickFileAsync({multipleFiles: true});
};

export const openFileForReading = async (file: TransferFile): Promise<FileReader> => {
    return await NativeFileReaderModule.open(file.uri);
}

export const readFileChunk = async (reader: FileReader, size: number) => {
    return await NativeFileReaderModule.read(reader, size);
}

export const closeFileReader = async (reader: FileReader) => {
    await NativeFileReaderModule.close(reader);
};

export const pickReceiveDirectory = () => Directory.pickDirectoryAsync();

export const getReceiveDirectoryUri = (directory: ReceiveDirectory) => directory.uri;

export const restoreReceiveDirectory = (uri: string): ReceiveDirectory => new Directory(uri);

export const createReceiveFile = async (directory: ReceiveDirectory, filename: string): Promise<ReceiveFile> => {
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
