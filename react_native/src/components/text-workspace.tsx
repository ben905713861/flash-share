import React, {useEffect, useImperativeHandle, useRef, useState} from "react";
import { Text, TextInput, View } from "react-native";
import storage from "@/lib/storage";
import { C, s } from "@/styles";

const TEXT_STORAGE_KEY = "flash-share-text";

type TextWorkspaceProps = {
    ref: React.Ref<TextWorkspaceRef>;
    palette: (typeof C)["light"];
    textChannelSend: (value: string) => void;
};

export interface TextWorkspaceRef {
    setUserText: (content: string) => void;
}

export function TextWorkspace({ ref, palette, textChannelSend }: TextWorkspaceProps) {
    const [userText, setUserText] = useState(() => storage.get(TEXT_STORAGE_KEY) ?? "");
    const textChannelSendRef = useRef(textChannelSend);
    textChannelSendRef.current = textChannelSend;

    useImperativeHandle(ref, () => ({
        setUserText
    }), []);

    useEffect(() => {
        storage.set(TEXT_STORAGE_KEY, userText);
        if (!userText.trim()) {
            return;
        }
        const timer = setTimeout(() => textChannelSendRef.current(userText), 800);
        return () => clearTimeout(timer);
    }, [userText]);

    return (
        <View style={s.toolBlock}>
            <TextInput
                multiline
                value={userText}
                onChangeText={setUserText}
                placeholder="Write a note for the other device..."
                placeholderTextColor={palette.muted}
                style={[s.messageInput, { color: palette.text, borderColor: palette.border }]}
            />
            <Text style={{ color: palette.muted }}>{userText.length} characters</Text>
        </View>
    );
}
