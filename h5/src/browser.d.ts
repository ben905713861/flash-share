declare module "*.css";

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
}
