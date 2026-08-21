import { createMMKV } from 'react-native-mmkv'

const storage = createMMKV()

export default {
    get: (key: string) => {
        return storage.getString(key);
    },
    set: (key: string, value: string) => {
        return storage.set(key, value);
    },
    remove: (key: string) => {
        return storage.remove(key);
    },
};
