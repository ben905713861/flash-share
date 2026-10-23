import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { Update } from "@tauri-apps/plugin-updater";
import * as Updates from "expo-updates";
import { showConfirm } from "@/components/alert-modal";
import { findTauriUpdate, installTauriUpdate, isTauriEnvironment } from "@/lib/tauri-updater";
import { s } from "@/styles";

type AppUpdatePalette = {
    text: string;
    muted: string;
    border: string;
};

export function AppUpdate({ palette }: { palette: AppUpdatePalette }) {
    const isTauri = isTauriEnvironment();
    if (isTauri) return <TauriAppUpdate palette={palette} />;

    return <ExpoAppUpdate palette={palette} />;
}

function TauriAppUpdate({ palette }: { palette: AppUpdatePalette }) {
    const [updateStatus, setUpdateStatus] = useState("");
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [currentVersion, setCurrentVersion] = useState("Loading...");

    useEffect(() => {
        void getVersion()
            .then(setCurrentVersion)
            .catch(() => setCurrentVersion("Unknown"));
    }, []);

    const checkForUpdates = async () => {
        if (isCheckingUpdate) return;
        setIsCheckingUpdate(true);
        setUpdateStatus("Checking for updates...");
        try {
            const update = await findTauriUpdate();
            if (!update) {
                setUpdateStatus("You are up to date.");
                return;
            }

            setUpdateStatus(`Update ${update.version} is available.`);
            showConfirm(
                "Desktop update available",
                `A new version (${update.version}) is available. Download and install it now?`,
                () => void installUpdate(update),
                () => setUpdateStatus("Update postponed."),
            );
        } catch (error) {
            setUpdateStatus(error instanceof Error ? `Update failed: ${error.message}` : "Unable to check for updates.");
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const installUpdate = async (update: Update) => {
        setIsCheckingUpdate(true);
        setUpdateStatus("Downloading and installing update...");
        try {
            await installTauriUpdate(update);
        } catch (error) {
            setIsCheckingUpdate(false);
            setUpdateStatus(error instanceof Error ? `Update failed: ${error.message}` : "Unable to install update.");
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
                    disabled={isCheckingUpdate}
                    style={[s.settingsPathButton, { borderColor: palette.border, opacity: isCheckingUpdate ? 0.5 : 1 }]}
                    onPress={() => void checkForUpdates()}
                >
                    <Text style={[s.settingsPathButtonText, { color: palette.text }]}>{isCheckingUpdate ? "Updating..." : "Check for updates"}</Text>
                </Pressable>
                {isCheckingUpdate && <ActivityIndicator size="small" color="#2f6fed" />}
            </View>
            <Text accessibilityLiveRegion="polite" style={[s.settingsPath, { color: palette.muted }]}>{updateStatus}</Text>
        </>
    );
}

function ExpoAppUpdate({ palette }: { palette: AppUpdatePalette }) {
    const [updateStatus, setUpdateStatus] = useState("");
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateReady, setUpdateReady] = useState(false);
    const currentVersion = Updates.runtimeVersion ?? "Unknown";
    const updateId = Updates.updateId;
    const updateDate = Updates.createdAt?.toLocaleString();
    const currentUpdate = `${updateDate ?? ""} - ${updateId?.slice(0, 8) ?? ""}`;
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
            const availableUpdateDate = "createdAt" in result.manifest
                ? new Date(result.manifest.createdAt).toLocaleString()
                : undefined;
            const availableUpdateId = result.manifest.id;
            const availableUpdate = `${availableUpdateDate ?? ""} - ${availableUpdateId?.slice(0, 8) ?? ""}`;
            showConfirm(
                "JS update available",
                `A new JS update is available for App version ${currentVersion}.\n\nUpdate: ${availableUpdate}\n\nDownload and install it now?`,
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
            <Text style={[s.settingsPath, { color: palette.muted }]}>Update channel: {Updates.channel ?? "Not configured"}</Text>
            <Text style={[s.settingsPath, { color: palette.muted }]}>JS update: {currentUpdate}</Text>
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

export const shouldShowAppUpdate = Platform.OS === "ios" || Platform.OS === "android" || isTauriEnvironment();
