import {Appearance} from "react-native";
import type {ThemePreference} from "./theme";

export const applyThemePreference = (preference: ThemePreference) => {
    Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
};
