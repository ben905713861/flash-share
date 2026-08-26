import { NativeModule, requireNativeModule } from 'expo';

export type FileReaderModule = {
  open(uri: string): Promise<string>;
  read(handle: string, size: number): Promise<Uint8Array | null>;
  close(handle: string): Promise<void>;
};

export default requireNativeModule<FileReaderModule>(
    "NativeFileReader"
);
