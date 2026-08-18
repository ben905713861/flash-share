import {useEffect, useRef, useState} from 'react';
import {Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

type Status = 'connecting' | 'ready' | 'waiting' | 'connected' | 'error';
const key = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export default function HomeScreen() {
    const [pairKey] = useState(key), [target, setTarget] = useState(''), [status, setStatus] = useState<Status>('connecting'), [statusText, setStatusText] = useState('Connecting to signaling server'), [text, setText] = useState(''), [last, setLast] = useState(''), [dark, setDark] = useState(false);
    const socket = useRef<WebSocket | null>(null);
    const send = (type: string, data: unknown = {}) => {
        if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({
            type,
            data,
            roomKey: pairKey
        }));
    };
    useEffect(() => {
        try {
            const ws = new WebSocket((globalThis as any).process?.env?.EXPO_PUBLIC_WS_URL || 'wss://localhost:8011/ws');
            socket.current = ws;
            ws.onopen = () => {
                setStatus('ready');
                setStatusText('Ready to pair with another device');
                ws.send(JSON.stringify({type: 'PENDING_PAIR', data: {pairKey}}));
            };
            ws.onmessage = e => {
                try {
                    const m = JSON.parse(e.data);
                    if (m.type === 'PAIR_SUCC') {
                        setStatus('waiting');
                        setStatusText('Pairing complete. Waiting for connection');
                        send('JOIN_ROOM');
                    }
                    if (m.type === 'JOIN_ROOM_SUCC') {
                        setStatus('connected');
                        setStatusText('Secure peer-to-peer connection active');
                    }
                } catch {
                }
            };
            ws.onerror = () => {
                setStatus('error');
                setStatusText('Signaling server unavailable');
            };
        } catch {
            setStatus('error');
            setStatusText('Unable to connect to signaling server');
        }
        return () => socket.current?.close();
    }, []);
    const pair = () => {
        if (!target.trim()) return Alert.alert('Pair a device', 'Enter the other device pairing code');
        send('PAIR', {targetPairKey: target.trim()});
        setStatus('waiting');
        setStatusText('Requesting a secure pairing');
    };
    const palette = dark ? C.dark : C.light;
    return <SafeAreaView style={[s.safe, {backgroundColor: palette.bg}]}><ScrollView
        contentContainerStyle={s.content}><View style={s.top}><View style={s.brand}><Text style={s.mark}>F</Text><Text
        style={[s.brandText, {color: palette.text}]}>Flash Share</Text></View><Pressable onPress={() => setDark(!dark)}><Text
        style={s.theme}>{dark ? '☀' : '◒'}</Text></Pressable></View><View style={s.status}><View
        style={[s.dot, {backgroundColor: status === 'connected' ? '#2f9e68' : status === 'error' ? '#d9534f' : '#d9a441'}]}/><Text
        style={{color: palette.muted}}>{statusText}</Text></View>{status === 'connected' ?
        <View style={s.workspace}><Text style={[s.heading, {color: palette.text}]}>Text</Text><TextInput multiline
                                                                                                         value={text}
                                                                                                         onChangeText={setText}
                                                                                                         placeholder="Write a note for the other device..."
                                                                                                         placeholderTextColor={palette.muted}
                                                                                                         style={[s.input, {
                                                                                                             color: palette.text,
                                                                                                             borderColor: palette.border
                                                                                                         }]}/><View
            style={s.footer}><Text style={{color: palette.muted}}>{text.length} characters</Text><Pressable
            style={s.primary} onPress={() => {
            if (text.trim()) {
                send('TEXT', {text});
                setLast(text);
                setText('');
            }
        }}><Text style={s.primaryText}>Send message</Text></Pressable></View>{last ?
            <Text style={{color: palette.text}}>Last sent: {last}</Text> : null}</View> :
        <View style={[s.card, {backgroundColor: palette.card, borderColor: palette.border}]}><Text
            style={[s.heading, {color: palette.text}]}>Pair a device</Text><Text style={{color: palette.muted}}>Enter
            this pairing code on the other device.</Text><View style={s.code}><Text>Pairing code</Text><Text
            style={s.codeValue}>{pairKey}</Text></View><Text style={{color: palette.text}}>Other device
            code</Text><TextInput value={target} onChangeText={setTarget} placeholder="Pairing code"
                                  placeholderTextColor={palette.muted}
                                  style={[s.input, {color: palette.text, borderColor: palette.border}]}/><Pressable
            style={s.primary} onPress={pair}><Text style={s.primaryText}>Pair</Text></Pressable></View>}
    </ScrollView></SafeAreaView>;
}
const C = {
    light: {bg: '#f5f6f8', card: '#fff', text: '#18212b', muted: '#687482', border: '#d9dee5'},
    dark: {bg: '#12161b', card: '#1b222a', text: '#f0f3f6', muted: '#a1acb8', border: '#34404d'}
};
const s = StyleSheet.create({
    safe: {flex: 1},
    content: {width: '100%', maxWidth: 720, alignSelf: 'center', padding: 24, gap: 20},
    top: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
    brand: {flexDirection: 'row', alignItems: 'center', gap: 10},
    mark: {backgroundColor: '#2f6fed', color: '#fff', fontSize: 22, fontWeight: '800', padding: 8, borderRadius: 8},
    brandText: {fontSize: 20, fontWeight: '700'},
    theme: {fontSize: 22, padding: 10},
    status: {flexDirection: 'row', alignItems: 'center', gap: 8},
    dot: {width: 9, height: 9, borderRadius: 5},
    card: {marginTop: 30, padding: 24, borderRadius: 14, borderWidth: 1, gap: 16},
    heading: {fontSize: 25, fontWeight: '700'},
    code: {alignItems: 'center', padding: 18, backgroundColor: '#eef3ff', borderRadius: 10},
    codeValue: {fontSize: 22, fontWeight: '700', marginTop: 5},
    input: {minHeight: 48, borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16},
    primary: {
        backgroundColor: '#2f6fed',
        minHeight: 48,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20
    },
    primaryText: {color: '#fff', fontWeight: '700', fontSize: 16},
    workspace: {marginTop: 20, gap: 14},
    footer: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'}
});

