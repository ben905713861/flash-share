import { useEffect, useState } from "react";
import { FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { clearLogs, getLogs, subscribeLogs, type LogEntry } from "@/lib/logger";
import { C } from "@/styles";

export function LogViewer({ palette }: { palette: typeof C.light }) {
  const [visible, setVisible] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!visible) return;
    const update = () => setLogs(getLogs());
    const unsubscribe = subscribeLogs(update);
    update();
    return unsubscribe;
  }, [visible]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open logs"
        onPress={() => setVisible(true)}
        style={({ pressed }) => [styles.button, {
          right: Math.max(insets.right, 16), bottom: Math.max(insets.bottom, 16),
          opacity: pressed ? 0.75 : 1,
        }]}
      >
        <Text style={styles.buttonText}>Log</Text>
      </Pressable>
      <Modal transparent visible={visible} animationType="fade" onRequestClose={() => setVisible(false)}>
        <View style={[styles.backdrop, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
          <Pressable accessibilityLabel="Close logs" style={StyleSheet.absoluteFill} onPress={() => setVisible(false)} />
          <View style={[styles.dialog, { backgroundColor: palette.card, borderColor: palette.border }]}>
            <View style={[styles.header, { borderBottomColor: palette.border }]}>
              <Text style={[styles.title, { color: palette.text }]}>Logs ({logs.length})</Text>
              <Pressable accessibilityRole="button" onPress={clearLogs} style={styles.action}>
                <Text style={{ color: palette.muted }}>Clear</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Close logs" onPress={() => setVisible(false)} style={styles.action}>
                <Text style={[styles.close, { color: palette.text }]}>×</Text>
              </Pressable>
            </View>
            <FlatList
              style={styles.list}
              data={logs}
              keyExtractor={(entry) => String(entry.id)}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={<Text style={{ color: palette.muted }}>No logs yet.</Text>}
              renderItem={({ item }) => (
                <View style={[styles.entry, { borderBottomColor: palette.border }]}>
                  <Text style={[styles.metadata, { color: item.level === "error" ? "#e55353" : item.level === "warn" ? "#b7791f" : palette.muted }]}>
                    {new Date(item.timestamp).toLocaleTimeString()} · {item.level.toUpperCase()}
                  </Text>
                  <Text selectable style={[styles.message, { color: palette.text }]}>{item.message}</Text>
                </View>
              )}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    position: "absolute", width: 52, height: 52, borderRadius: 26,
    backgroundColor: "#2f6fed", alignItems: "center", justifyContent: "center",
    elevation: 6, zIndex: 10, boxShadow: "0 3px 10px rgba(0,0,0,0.2)",
  },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", paddingHorizontal: 16 },
  dialog: { width: "100%", maxWidth: 760, height: "80%", borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, borderBottomWidth: 1 },
  title: { flex: 1, fontSize: 18, fontWeight: "700" },
  action: { minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" },
  close: { fontSize: 28 },
  list: { flex: 1 },
  listContent: { padding: 16 },
  entry: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 6 },
  metadata: { fontSize: 11 },
  message: { fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
