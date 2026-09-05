import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import type { C } from "@/styles";
import { s } from "@/styles";

type AlertModalProps = {
    palette: (typeof C)["light"];
};

type AlertState = { title: string; message?: string } | null;
type AlertListener = (state: AlertState) => void;
type ConfirmState = {
    title: string;
    message?: string;
    onConfirm: () => void;
    onReject: () => void;
} | null;
type ConfirmListener = (state: ConfirmState) => void;

let currentAlert: AlertState = null;
const listeners = new Set<AlertListener>();
let currentConfirm: ConfirmState = null;
const confirmListeners = new Set<ConfirmListener>();

export function showAlert(title: string, message?: string) {
    currentAlert = { title, message };
    listeners.forEach((listener) => listener(currentAlert));
}

export function hideAlert() {
    currentAlert = null;
    listeners.forEach((listener) => listener(currentAlert));
}

export function showConfirm(
    title: string,
    message: string | undefined,
    onConfirm: () => void,
    onReject: () => void,
) {
    currentConfirm = { title, message, onConfirm, onReject };
    confirmListeners.forEach((listener) => listener(currentConfirm));
}

export function hideConfirm(rejected = true) {
    const state = currentConfirm;
    currentConfirm = null;
    confirmListeners.forEach((listener) => listener(null));
    if (state) {
        (rejected ? state.onReject : state.onConfirm)();
    }
}

export function AlertModal({ palette }: AlertModalProps) {
    const [alertState, setAlertState] = useState<AlertState>(currentAlert);
    const [confirmState, setConfirmState] = useState<ConfirmState>(currentConfirm);

    useEffect(() => {
        listeners.add(setAlertState);
        confirmListeners.add(setConfirmState);
        return () => {
            listeners.delete(setAlertState);
            confirmListeners.delete(setConfirmState);
        };
    }, []);

    const visible = alertState !== null;

    return (
        <>
        <Modal transparent visible={visible} animationType="fade" onRequestClose={hideAlert}>
            <View style={s.modalBackdrop}>
                <View style={[s.dialog, s.alertDialog, { backgroundColor: palette.card, borderColor: palette.border }]}>
                    <Text style={[s.settingsTitle, { color: palette.text }]}>{alertState?.title}</Text>
                    {alertState?.message ? <Text style={{ color: palette.muted }}>{alertState.message}</Text> : null}
                    <Pressable accessibilityRole="button" style={s.primary} onPress={hideAlert}>
                        <Text style={s.primaryText}>OK</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
        <Modal transparent visible={confirmState !== null} animationType="fade" onRequestClose={() => hideConfirm()}>
            <View style={s.modalBackdrop}>
                <View style={[s.dialog, s.alertDialog, { backgroundColor: palette.card, borderColor: palette.border }]}>
                    <Text style={[s.settingsTitle, { color: palette.text }]}>{confirmState?.title}</Text>
                    {confirmState?.message ? <Text style={{ color: palette.muted }}>{confirmState.message}</Text> : null}
                    <View style={{ flexDirection: "row", gap: 12 }}>
                        <Pressable accessibilityRole="button" style={[s.secondary, { flex: 1 }]} onPress={() => hideConfirm()}>
                            <Text style={[s.secondaryText, { color: palette.text }]}>Reject</Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" style={[s.primary, { flex: 1 }]} onPress={() => hideConfirm(false)}>
                            <Text style={s.primaryText}>Confirm</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </Modal>
        </>
    );
}
