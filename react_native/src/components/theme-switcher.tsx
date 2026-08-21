import {useEffect, useState} from "react";
import {Pressable, StyleSheet, Text, useColorScheme} from "react-native";
import storage from "@/components/storage";

type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const THEME_STORAGE_KEY = "flash-share-theme";

type ThemeSwitcherProps = {
    onThemeChange: (theme: ResolvedTheme) => void;
};

export function ThemeSwitcher({onThemeChange}: ThemeSwitcherProps) {
    const systemColorScheme = useColorScheme();
    const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
        const saved = storage.get(THEME_STORAGE_KEY);
        return saved === "light" || saved === "dark" ? saved : "system";
    });
    const systemDark = systemColorScheme === "dark";
    const resolvedTheme: ResolvedTheme = themePreference === "system"
        ? (systemDark ? "dark" : "light")
        : themePreference;

    useEffect(() => {
        onThemeChange(resolvedTheme);
    }, [onThemeChange, resolvedTheme]);

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
