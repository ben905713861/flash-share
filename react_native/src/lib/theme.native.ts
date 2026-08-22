export type ThemePreference = "system" | "light" | "dark";

import {Appearance} from "react-native";

export const applyThemePreference = (preference: ThemePreference) => {
    Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
};
