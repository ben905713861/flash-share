import type { Update } from "@tauri-apps/plugin-updater";

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function findTauriUpdate(): Promise<Update | null> {
  if (!isTauriEnvironment()) return null;

  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

export async function installTauriUpdate(update: Update): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await update.downloadAndInstall();
  await relaunch();
}

export async function checkForTauriUpdate(): Promise<void> {
  if (!isTauriEnvironment()) return;

  try {
    const update = await findTauriUpdate();
    if (!update) return;

    await installTauriUpdate(update);
  } catch (error) {
    console.warn("Tauri updater check failed", error);
  }
}
