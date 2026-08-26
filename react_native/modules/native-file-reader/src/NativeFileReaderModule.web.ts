import { registerWebModule, NativeModule } from 'expo';

// NativeFileReaderModule is not available on the web platform.
class NativeFileReaderModule extends NativeModule<{}> {}

export default registerWebModule(NativeFileReaderModule, 'NativeFileReaderModule');
