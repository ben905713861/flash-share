import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useState } from "react";
import * as Updates from "expo-updates";
import Constants from "expo-constants";
import { showConfirm } from "@/components/alert-modal";
import { s } from "@/styles";

type AppUpdatePalette = {
    text: string;
    muted: string;
    border: string;
};

export function AppUpdate({ palette }: { palette: AppUpdatePalette }) {
    const [updateStatus, setUpdateStatus] = useState("");
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateReady, setUpdateReady] = useState(false);
    const currentVersion = Constants.expoConfig?.version ?? "Unknown";
    const canCheckForUpdates = !__DEV__ && Updates.isEnabled;

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
        if (!canCheckForUpdates || isCheckingUpdate) return;
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

    return (
        <>
            <View style={[s.settingsDivider, { backgroundColor: palette.border }]} />
            <Text style={[s.settingsLabel, { color: palette.text }]}>App update</Text>
            <Text style={[s.settingsPath, { color: palette.muted }]}>Current version: {currentVersion}</Text>
            <View style={s.settingsPathActions}>
                <Pressable
                    accessibilityRole="button"
                    disabled={!canCheckForUpdates || isCheckingUpdate}
                    style={[s.settingsPathButton, { borderColor: palette.border, opacity: !canCheckForUpdates || isCheckingUpdate ? 0.5 : 1 }]}
                    onPress={() => checkForUpdates()}
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
                {updateStatus || (!canCheckForUpdates ? "Updates are available in production builds only." : "")}
            </Text>
        </>
    );
}

export const shouldShowAppUpdate = Platform.OS === "ios" || Platform.OS === "android";
