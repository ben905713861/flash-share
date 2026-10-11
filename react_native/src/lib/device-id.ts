import storage from "./storage";

const DEVICE_ID_STORAGE_KEY = "flash-share-device-id";

function createDeviceId(): string {
    return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getDeviceId(): string {
    const storedId = storage.get(DEVICE_ID_STORAGE_KEY);
    if (storedId) {
        return storedId;
    }

    const deviceId = createDeviceId();
    storage.set(DEVICE_ID_STORAGE_KEY, deviceId);
    return deviceId;
}
