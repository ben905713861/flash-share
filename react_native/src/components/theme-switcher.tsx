import {useEffect, useState} from "react";
import {Appearance, Pressable, StyleSheet, Text} from "react-native";
import storage from "@/components/storage";

type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "flash-share-theme";

export function ThemeSwitcher() {
    const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
        const saved = storage.get(THEME_STORAGE_KEY);
        return saved === "light" || saved === "dark" ? saved : "system";
    });
    useEffect(() => {
        Appearance.setColorScheme(themePreference === "system" ? "unspecified" : themePreference);
    }, [themePreference]);

    useEffect(() => {
        if (themePreference === "system") {
            storage.remove(THEME_STORAGE_KEY);
        } else {
            storage.set(THEME_STORAGE_KEY, themePreference);
        }
    }, [themePreference]);

    const toggleTheme = () => {
        setThemePreference((current) => {
            if (current === "system") return "light";
            if (current === "light") return "dark";
            return "system";
        });
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
