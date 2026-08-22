import {Pressable, StyleSheet, Text} from "react-native";
import type {ThemePreference} from "@/lib/theme";

type ThemeSwitcherProps = {
    themePreference: ThemePreference;
    onChange: (preference: ThemePreference) => void;
};

export function ThemeSwitcher({themePreference, onChange}: ThemeSwitcherProps) {

    const toggleTheme = () => {
        const next = themePreference === "system"
            ? "light"
            : themePreference === "light"
                ? "dark"
                : "system";
        onChange(next);
    };

    const themeIcon = themePreference === "system" ? "◒" : themePreference === "light" ? "☀" : "🌙";

    return (
        <Pressable onPress={toggleTheme} accessibilityRole="button" accessibilityLabel="Switch theme">
            <Text style={styles.theme}>{themeIcon}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    theme: {fontSize: 22, padding: 8},
});
