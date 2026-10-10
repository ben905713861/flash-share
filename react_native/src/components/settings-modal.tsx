import { ActivityIndicator, Modal, Platform, Pressable, Text, View } from "react-native";
import type { ThemePreference } from "@/lib/theme";
import { s } from "@/styles";
import {getReceiveDirectoryUri, pickReceiveDirectory} from "@/lib/file-transfer";
import storage from "@/lib/storage";
import {showAlert, showConfirm} from "@/components/alert-modal";
import {useEffect, useState} from "react";
import * as Updates from "expo-updates";
import Constants from "expo-constants";

type SettingsPalette = {
    card: string;
    text: string;
    muted: string;
    border: string;
};

type SettingsModalProps = {
    visible: boolean;
    themePreference: ThemePreference;
    palette: SettingsPalette;
    onThemeChange: (preference: ThemePreference) => void;
    onClose: () => void;
    onLogout: () => void;
};

const themeOptions: Array<{ value: ThemePreference; label: string }> = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
];

export function SettingsModal({
    visible,
    themePreference,
    palette,
    onThemeChange,
    onClose,
    onLogout,
}: SettingsModalProps) {
    const showReceiveDirectory =
        Platform.OS !== "web" || (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window);
    const showAppUpdates = Platform.OS === "ios" || Platform.OS === "android";

    const [receiveDirectoryUri, setReceiveDirectoryUri] = useState<string | undefined>(() => storage.get("receive-directory"));
    const [updateStatus, setUpdateStatus] = useState("");
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateReady, setUpdateReady] = useState(false);
    const currentVersion = Constants.expoConfig?.version ?? "Unknown";

    const downloadUpdate = async () => {
        setIsCheckingUpdate(true);
        setUpdateStatus("Downloading update...");
        try {
            const fetched = await Updates.fetchUpdateAsync();
            if (fetched.isNew || fetched.isRollBackToEmbedded) {
                setUpdateReady(true);
                setUpdateStatus("Update downloaded and ready to apply.");
            } else {
                setUpdateStatus("No new update was downloaded.");
            }
        } catch (error) {
            setUpdateStatus(error instanceof Error ? `Update failed: ${error.message}` : "Unable to download update.");
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const checkForUpdates = async () => {
        if (!Updates.isEnabled || isCheckingUpdate) return;
        setIsCheckingUpdate(true);
        setUpdateReady(false);
        setUpdateStatus("Checking for updates...");
        try {
            const result = await Updates.checkForUpdateAsync();
            if (!result.isAvailable) {
                setUpdateStatus("You are up to date.");
                return;
            }
            setUpdateStatus("Update available.");
            showConfirm(
                "Update available",
                "A new version is available. Download and install it now?",
                () => void downloadUpdate(),
                () => setUpdateStatus("Update postponed."),
            );
        } catch (error) {
            setUpdateStatus(error instanceof Error ? `Update failed: ${error.message}` : "Unable to check for updates.");
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    useEffect(() => {
        if (visible) {
            setReceiveDirectoryUri(storage.get("receive-directory"));
        }
    }, [visible]);

    const onReceiveDirectorySelect = async () => {
        try {
            const directory = await pickReceiveDirectory();
            const uri = getReceiveDirectoryUri(directory);
            if (!uri) {
                return Promise.reject("This platform cannot save a persistent folder setting.");
            }
            storage.set("receive-directory", uri);
            setReceiveDirectoryUri(uri);
        } catch (error) {
            if (error instanceof Error) {
                showAlert("Unable to select folder", error.message);
            }
        }
    };

    const onReceiveDirectoryClear = () => {
        storage.remove("receive-directory");
        setReceiveDirectoryUri(undefined);
    };


    return (
        <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
            <View style={s.modalBackdrop}>
                <Pressable accessibilityLabel="Close settings" style={s.settingsDismiss} onPress={onClose} />
                <View style={[s.settingsDialog, { backgroundColor: palette.card, borderColor: palette.border }]}>
                    <View style={s.settingsHeader}>
                        <Text style={[s.settingsTitle, { color: palette.text }]}>Setting</Text>
                        <Pressable accessibilityLabel="Close settings" onPress={onClose}>
                            <Text style={[s.settingsClose, { color: palette.muted }]}>×</Text>
                        </Pressable>
                    </View>
                    <Text style={[s.settingsLabel, { color: palette.text }]}>Theme</Text>
                    <View style={[s.themeSegment, { borderColor: palette.border }]}>
                        {themeOptions.map(({ value, label }) => {
                            const selected = themePreference === value;
                            return (
                                <Pressable
                                    key={value}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected }}
                                    style={[s.themeSegmentItem, selected && s.themeSegmentSelected]}
                                    onPress={() => onThemeChange(value)}
                                >
                                    <Text style={[s.themeSegmentText, selected && s.themeSegmentSelectedText]}>{label}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    {showAppUpdates && (
                        <>
                            <View style={[s.settingsDivider, { backgroundColor: palette.border }]} />
                            <Text style={[s.settingsLabel, { color: palette.text }]}>App update</Text>
                            <Text style={[s.settingsPath, { color: palette.muted }]}>Current version: {currentVersion}</Text>
                            <View style={s.settingsPathActions}>
                                <Pressable
                                    accessibilityRole="button"
                                    disabled={!Updates.isEnabled || isCheckingUpdate}
                                    style={[s.settingsPathButton, { borderColor: palette.border, opacity: !Updates.isEnabled || isCheckingUpdate ? 0.5 : 1 }]}
                                    onPress={() => void checkForUpdates()}
                                >
                                    <Text style={[s.settingsPathButtonText, { color: palette.text }]}>{isCheckingUpdate ? "Checking..." : "Check for updates"}</Text>
                                </Pressable>
                                {isCheckingUpdate && <ActivityIndicator size="small" color="#2f6fed" />}
                                {updateReady && (
                                    <Pressable style={[s.settingsPathButton, { borderColor: palette.border }]} onPress={() => void Updates.reloadAsync()}>
                                        <Text style={[s.settingsPathButtonText, { color: palette.text }]}>Restart now</Text>
                                    </Pressable>
                                )}
                            </View>
                            <Text accessibilityLiveRegion="polite" style={[s.settingsPath, { color: palette.muted }]}>
                                {updateStatus}
                            </Text>
                        </>
                    )}
                    {showReceiveDirectory && (
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
                    )}
                    <View style={[s.settingsDivider, { backgroundColor: palette.border }]} />
                    <Pressable style={s.settingsLogout} onPress={onLogout}>
                        <Text style={s.settingsLogoutText}>Logout</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}
