export async function checkForTauriUpdate(): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const { relaunch } = await import("@tauri-apps/plugin-process");
    const update = await check();
    if (!update) return;

    await update.downloadAndInstall();
    await relaunch();
  } catch (error) {
    console.warn("Tauri updater check failed", error);
  }
}
