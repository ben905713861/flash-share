import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import type { C } from "@/styles";
import { s } from "@/styles";

type AlertModalProps = {
    palette: (typeof C)["light"];
};

type AlertState = { title: string; message?: string } | null;
type AlertListener = (state: AlertState) => void;

let currentAlert: AlertState = null;
const listeners = new Set<AlertListener>();

export function showAlert(title: string, message?: string) {
    currentAlert = { title, message };
    listeners.forEach((listener) => listener(currentAlert));
}

export function hideAlert() {
    currentAlert = null;
    listeners.forEach((listener) => listener(currentAlert));
}

export function AlertModal({ palette }: AlertModalProps) {
    const [alertState, setAlertState] = useState<AlertState>(currentAlert);

    useEffect(() => {
        listeners.add(setAlertState);
        return () => {
            listeners.delete(setAlertState);
        };
    }, []);

    const visible = alertState !== null;

    return (
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
    );
}
