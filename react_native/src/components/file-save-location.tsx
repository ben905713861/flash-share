import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { showAlert } from "@/components/alert-modal";
import { getReceiveDirectoryUri, pickReceiveDirectory } from "@/lib/file-transfer";
import storage from "@/lib/storage";
import { s } from "@/styles";

const RECEIVE_DIRECTORY_STORAGE_KEY = "receive-directory";

export function supportsFileSaveLocation(): boolean {
  return Platform.OS !== "web" || (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
}

export function getFileSaveLocation(): string | undefined {
  return storage.get(RECEIVE_DIRECTORY_STORAGE_KEY);
}

export function setFileSaveLocation(value: string): void {
  storage.set(RECEIVE_DIRECTORY_STORAGE_KEY, value);
}

export function clearFileSaveLocation(): void {
  storage.remove(RECEIVE_DIRECTORY_STORAGE_KEY);
}

type FileSaveLocationProps = {
  visible: boolean;
  palette: {
    text: string;
    muted: string;
    border: string;
  };
};

export function FileSaveLocation({ visible, palette }: FileSaveLocationProps) {
  const [receiveDirectoryUri, setReceiveDirectoryUri] = useState<string | undefined>(getFileSaveLocation);

  useEffect(() => {
    if (visible) {
      setReceiveDirectoryUri(getFileSaveLocation());
    }
  }, [visible]);

  const onReceiveDirectorySelect = async () => {
    try {
      const directory = await pickReceiveDirectory();
      const uri = getReceiveDirectoryUri(directory);
      if (!uri) {
        return Promise.reject("This platform cannot save a persistent folder setting.");
      }
      setFileSaveLocation(uri);
      setReceiveDirectoryUri(uri);
    } catch (error) {
      if (error instanceof Error) {
        showAlert("Unable to select folder", error.message);
      }
    }
  };

  const onReceiveDirectoryClear = () => {
    clearFileSaveLocation();
    setReceiveDirectoryUri(undefined);
  };

  if (!supportsFileSaveLocation()) {
    return null;
  }

  return (
    <>
      <View style={[s.settingsDivider, { backgroundColor: palette.border }]} />
      <Text style={[s.settingsLabel, { color: palette.text }]}>File save location</Text>
      <Text numberOfLines={1} style={[s.settingsPath, { color: palette.muted }]}>
        {receiveDirectoryUri || "Ask every time"}
      </Text>
      <View style={s.settingsPathActions}>
        <Pressable style={[s.settingsPathButton, { borderColor: palette.border }]} onPress={() => void onReceiveDirectorySelect()}>
          <Text style={[s.settingsPathButtonText, { color: palette.text }]}>Choose folder</Text>
        </Pressable>
        {receiveDirectoryUri && (
          <Pressable style={s.settingsClear} onPress={onReceiveDirectoryClear}>
            <Text style={s.settingsClearText}>Clear</Text>
          </Pressable>
        )}
      </View>
    </>
  );
}
