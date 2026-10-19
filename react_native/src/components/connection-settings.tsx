import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import storage from "@/lib/storage";
import { s } from "@/styles";

const readSetting = (storageKey: string, defaultValue: number) => {
    const value = Number(storage.get(storageKey));
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
};

export const getWsReconnectTimeout = () => readSetting("flash-share-ws-reconnect-timeout", 1000);
export const setWsReconnectTimeout = (value: number) => storage.set("flash-share-ws-reconnect-timeout", String(value));
export const getHeartbeatInterval = () => readSetting("flash-share-heartbeat-interval", 1000);
export const setHeartbeatInterval = (value: number) => storage.set("flash-share-heartbeat-interval", String(value));
export const getWebrtcReconnectTimeout = () => readSetting("flash-share-webrtc-reconnect-timeout", 2000);
export const setWebrtcReconnectTimeout = (value: number) => storage.set("flash-share-webrtc-reconnect-timeout", String(value));

type ConnectionSettingsProps = {
    palette: { text: string; border: string };
};

export function ConnectionSettings({ palette }: ConnectionSettingsProps) {
    const [wsReconnectTimeout, setWsReconnectTimeoutState] = useState(getWsReconnectTimeout);
    const [heartbeatInterval, setHeartbeatIntervalState] = useState(getHeartbeatInterval);
    const [webrtcReconnectTimeout, setWebrtcReconnectTimeoutState] = useState(getWebrtcReconnectTimeout);
    const renderTimeoutField = (
        label: string,
        storageKey: string,
        value: number,
        setValue: (value: number) => void,
        saveValue: (value: number) => void,
    ) => (
        <View key={storageKey} style={s.settingsTimeoutRow}>
            <Text style={[s.settingsPath, { color: palette.text }]}>{label}</Text>
            <TextInput
                keyboardType="numeric"
                value={String(value)}
                onChangeText={(text) => {
                    const next = Number(text);
                    if (Number.isFinite(next) && next > 0) {
                        const rounded = Math.round(next);
                        setValue(rounded);
                        saveValue(rounded);
                    }
                }}
                style={[s.settingsTimeoutInput, { color: palette.text, borderColor: palette.border }]}
            />
        </View>
    );

    return (
        <>
            <Text style={[s.settingsLabel, { color: palette.text }]}>Connection timeouts</Text>
            {renderTimeoutField("WebSocket reconnect (ms)", "wsReconnectTimeout", wsReconnectTimeout, setWsReconnectTimeoutState, setWsReconnectTimeout)}
            {renderTimeoutField("Heartbeat interval (ms)", "heartbeatInterval", heartbeatInterval, setHeartbeatIntervalState, setHeartbeatInterval)}
            {renderTimeoutField("WebRTC reconnect (ms)", "webrtcReconnectTimeout", webrtcReconnectTimeout, setWebrtcReconnectTimeoutState, setWebrtcReconnectTimeout)}
        </>
    );
}
