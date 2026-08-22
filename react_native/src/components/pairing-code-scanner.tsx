import { useRef, useState } from "react";
import { Alert, Modal, Pressable, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { s } from "@/styles";

type PairingCodeScannerProps = { onScanned: (code: string) => void };

export function PairingCodeScanner({ onScanned }: PairingCodeScannerProps) {
    const [isOpen, setOpen] = useState(false);
    const [permission, requestPermission] = useCameraPermissions();
    const hasScannedRef = useRef(false);

    const openScanner = async () => {
        hasScannedRef.current = false;
        if (!permission?.granted) {
            const result = await requestPermission();
            if (!result.granted) {
                Alert.alert("Camera permission required", "Allow camera access to scan a pairing code.");
                return;
            }
        }
        setOpen(true);
    };

    const handleBarcodeScanned = ({ data }: { data: string }) => {
        if (hasScannedRef.current || !data.trim()) return;
        hasScannedRef.current = true;
        setOpen(false);
        onScanned(data.trim());
    };

    return (
        <>
            <Pressable accessibilityRole="button" accessibilityLabel="Scan pairing code with camera" style={s.cameraButton} onPress={() => void openScanner()}>
                <Text style={s.cameraButtonText}>📷</Text>
            </Pressable>
            <Modal visible={isOpen} animationType="slide" onRequestClose={() => setOpen(false)}>
                <View style={s.scanner}>
                    <CameraView style={s.scannerCamera} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={handleBarcodeScanned} />
                    <View style={s.scannerHeader}>
                        <Text style={s.scannerTitle}>扫描配对二维码</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel="Close camera scanner" style={s.scannerClose} onPress={() => setOpen(false)}>
                            <Text style={s.scannerCloseText}>关闭</Text>
                        </Pressable>
                    </View>
                </View>
            </Modal>
        </>
    );
}
