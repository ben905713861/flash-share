export type ThemePreference = "system" | "light" | "dark";

// Metro resolves theme.native.ts or theme.web.ts at bundle time.
// This declaration keeps the shared import type-safe without selecting a platform.
export declare const applyThemePreference: (preference: ThemePreference) => void;
