export type Storage = {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
    remove: (key: string) => void;
};

// Metro selects storage.native.ts or storage.web.ts for the active platform.
export declare const storage: Storage;
export default storage;
