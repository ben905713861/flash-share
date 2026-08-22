import { Pressable, Text, TextInput, View } from "react-native";
import { C, s } from "@/styles";

type TextWorkspaceProps = {
    value: string;
    palette: (typeof C)["light"];
    onChangeText: (value: string) => void;
    onSend: (value: string) => void;
};

export function TextWorkspace({ value, palette, onChangeText, onSend }: TextWorkspaceProps) {
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
            <View style={s.footer}>
                <Text style={{ color: palette.muted }}>{value.length} characters</Text>
                <Pressable
                    style={[s.primary, !value.trim() && s.disabled]}
                    disabled={!value.trim()}
                    onPress={() => onSend(value)}
                >
                    <Text style={s.primaryText}>Send message</Text>
                </Pressable>
            </View>
        </View>
    );
}
