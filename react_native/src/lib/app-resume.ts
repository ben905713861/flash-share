import {AppState, type AppStateStatus} from "react-native";

type ResumeCallback = () => void;

/**
 * Subscribes to foreground/resume events across native, web, and Tauri.
 * Returns a synchronous cleanup function; a Tauri listener that is still
 * registering is removed as soon as registration completes.
 */
export const subscribeToAppResume = (onResume: ResumeCallback): (() => void) => {
    let previousAppState: AppStateStatus = AppState.currentState;
    let disposed = false;
    let removeTauriFocusListener: (() => void) | undefined;

    const appStateSubscription = AppState.addEventListener("change", (nextAppState) => {
        const resumed = previousAppState !== "active" && nextAppState === "active";
        previousAppState = nextAppState;
        if (resumed) {
            onResume();
        }
    });

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        void import("@tauri-apps/api/window")
            .then(({getCurrentWindow}) => getCurrentWindow().onFocusChanged(({payload: focused}) => {
                if (focused) {
                    onResume();
                }
            }))
            .then((removeListener) => {
                if (disposed) {
                    removeListener();
                } else {
                    removeTauriFocusListener = removeListener;
                }
            });
    }

    return () => {
        disposed = true;
        appStateSubscription.remove();
        removeTauriFocusListener?.();
    };
};
