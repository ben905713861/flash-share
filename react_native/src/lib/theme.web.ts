export type ThemePreference = "system" | "light" | "dark";

export const applyThemePreference = (preference: ThemePreference) => {
    const root = document.documentElement;
    const resolved = preference === "system"
        ? (globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : preference;
    root.style.colorScheme = resolved;
    root.dataset.theme = resolved;
};
