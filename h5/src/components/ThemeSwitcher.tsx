import { useEffect, useState } from "react";
import storage from "../lib/storage";

type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "flash-share-theme";

export function ThemeSwitcher() {
    const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
        const saved = storage.get(THEME_STORAGE_KEY);
        return saved === "light" || saved === "dark" ? saved : "system";
    });
    const [systemDark, setSystemDark] = useState(false);

    useEffect(() => {
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const update = () => setSystemDark(media.matches);
        update();
        media.addEventListener?.("change", update);
        return () => media.removeEventListener?.("change", update);
    }, []);

    useEffect(() => {
        document.documentElement.dataset.theme = themePreference === "system"
            ? (systemDark ? "dark" : "light")
            : themePreference;

        if (themePreference === "system") {
            storage.remove(THEME_STORAGE_KEY);
        } else {
            storage.set(THEME_STORAGE_KEY, themePreference);
        }
    }, [themePreference, systemDark]);

    const resolvedTheme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;
    const themeIcon = themePreference === "system" ? "◒" : themePreference === "light" ? "☀" : "🌙";
    const themeName = themePreference === "system" ? "Auto" : themePreference === "light" ? "Light" : "Dark";

    const toggleTheme = () => {
        setThemePreference((current) => {
            if (current === "system") return "light";
            if (current === "light") return "dark";
            return "system";
        });
    };

    return (
        <button
            className={`theme-button ${resolvedTheme}`}
            type="button"
            onClick={toggleTheme}
            title={`Theme: ${themeName}. Click to switch.`}
            aria-label={`Theme: ${themeName}. Click to switch.`}
        >
            <span className="theme-icon" aria-hidden="true">{themeIcon}</span>
        </button>
    );
}
