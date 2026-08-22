import {createMMKV} from "react-native-mmkv";
import type {Storage} from "./storage";

const mmkv = createMMKV();

const storage: Storage = {
    get: (key) => mmkv.getString(key),
    set: (key, value) => mmkv.set(key, value),
    remove: (key) => mmkv.remove(key),
};

export default storage;
