import { useEffect, useRef } from "react";
import { Text, TextInput, View } from "react-native";
import { C, s } from "@/styles";

type TextWorkspaceProps = {
    value: string;
    palette: (typeof C)["light"];
    onChangeText: (value: string) => void;
    onSend: (value: string) => void;
};

export function TextWorkspace({ value, palette, onChangeText, onSend }: TextWorkspaceProps) {
    const onSendRef = useRef(onSend);
    onSendRef.current = onSend;

    useEffect(() => {
        if (!value.trim()) return;
        const timer = setTimeout(() => onSendRef.current(value), 800);
        return () => clearTimeout(timer);
    }, [value]);

    return (
        <View style={s.toolBlock}>
            <TextInput
                multiline
                value={value}
                onChangeText={onChangeText}
                placeholder="Write a note for the other device..."
                placeholderTextColor={palette.muted}
                style={[s.messageInput, { color: palette.text, borderColor: palette.border }]}
            />
            <Text style={{ color: palette.muted }}>{value.length} characters</Text>
        </View>
    );
}
