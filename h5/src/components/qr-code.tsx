import { useEffect, useRef } from "react";
import QRCode from "qrcode";

type QrCodeInput = {
    value: string,
    size: number,
};

export default function QrCode(props: QrCodeInput) {
    const { value, size } = props;
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !value) {
            return;
        }

        void QRCode.toCanvas(canvas, value, {
            width: size,
            margin: 1,
            errorCorrectionLevel: "M",
            color: { dark: "#000000", light: "#ffffff" },
        });
    }, [value]);

    return <canvas ref={canvasRef} width="204" height="204" aria-label="Pairing QR code" role="img" />;
}
