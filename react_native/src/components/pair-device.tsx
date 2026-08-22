import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { PairingCodeScanner } from "@/components/pairing-code-scanner";
import { C, s } from "@/styles";

type PairDeviceProps = {
    pairKey: string;
    targetPairKey: string;
    palette: (typeof C)["light"];
    onTargetPairKeyChange: (value: string) => void;
    onPair: (value: string) => void;
};

export function PairDevice({
    pairKey,
    targetPairKey,
    palette,
    onTargetPairKeyChange,
    onPair,
}: PairDeviceProps) {
    return (
        <View style={[s.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
            <Text style={[s.heading, { color: palette.text }]}>Pair a device!</Text>
            <Text style={{ color: palette.muted }}>Enter this pairing code on the other device.</Text>
            <View style={s.code}>
                <Text style={{ color: palette.text }}>Pairing code</Text>
                <View style={s.qrFrame}>
                    {pairKey ? <QRCode value={pairKey} size={180} /> : <ActivityIndicator color="#2f6fed" />}
                </View>
                <Text style={[s.codeValue, { color: palette.text }]}>{pairKey || "Preparing..."}</Text>
            </View>
            <Text style={{ color: palette.text }}>Other device code</Text>
            <View style={[s.inputContainer, { borderColor: palette.border }]}>
                <TextInput
                    value={targetPairKey}
                    onChangeText={onTargetPairKeyChange}
                    placeholder="Pairing code"
                    placeholderTextColor={palette.muted}
                    style={[s.input, { color: palette.text }]}
                />
                <PairingCodeScanner onScanned={(code) => {
                    onTargetPairKeyChange(code);
                    onPair(code);
                }} />
            </View>
            <Pressable style={s.primary} onPress={() => onPair(targetPairKey)}>
                <Text style={s.primaryText}>Pair</Text>
            </Pressable>
        </View>
    );
}
