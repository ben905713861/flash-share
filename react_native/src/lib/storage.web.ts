import type {Storage} from "./storage";

const storage: Storage = {
    get: (key) => localStorage.getItem(key) ?? undefined,
    set: (key, value) => localStorage.setItem(key, value),
    remove: (key) => localStorage.removeItem(key),
};

export default storage;
