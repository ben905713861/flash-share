import { Modal, Pressable, Text, View } from "react-native";
import type { ThemePreference } from "@/lib/theme";
import { s } from "@/styles";

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
                    <View style={[s.settingsDivider, { backgroundColor: palette.border }]} />
                    <Pressable style={s.settingsLogout} onPress={onLogout}>
                        <Text style={s.settingsLogoutText}>Logout</Text>
                    </Pressable>
                </View>
            </View>
        </Modal>
    );
}
