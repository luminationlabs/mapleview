import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { debugLogStore, useDebugLog, type DebugLogEntry } from "@/src/utils/debug-log";
import { useUIStore } from "@/src/store/ui-store";

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function levelColor(level: DebugLogEntry["level"]): string {
  switch (level) {
    case "error":
      return "#FF453A";
    case "warn":
      return "#FFD60A";
    default:
      return "#A0A0A0";
  }
}

export function DebugLogOverlay() {
  const [open, setOpen] = useState(false);
  const entries = useDebugLog((s) => s.entries);
  const visible = useUIStore((s) => s.debugMode);

  if (!visible) return null;

  // Newest first
  const data = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={styles.fab}
        hitSlop={8}
        accessibilityLabel="Open debug log"
      >
        <Text style={styles.fabText}>LOG</Text>
        {entries.length > 0 && (
          <Text style={styles.fabCount}>{entries.length}</Text>
        )}
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="overFullScreen"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView style={styles.modal}>
          <View style={styles.header}>
            <Text style={styles.title}>Debug log ({entries.length})</Text>
            <View style={styles.headerButtons}>
              <Pressable
                onPress={() => debugLogStore.getState().clear()}
                style={styles.headerBtn}
              >
                <Text style={styles.headerBtnText}>Clear</Text>
              </Pressable>
              <Pressable
                onPress={() => setOpen(false)}
                style={styles.headerBtn}
              >
                <Text style={styles.headerBtnText}>Close</Text>
              </Pressable>
            </View>
          </View>

          <FlatList
            data={data}
            keyExtractor={(e) => String(e.id)}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text style={styles.time}>{formatTime(item.timestamp)}</Text>
                <Text
                  style={[styles.message, { color: levelColor(item.level) }]}
                  selectable
                >
                  {item.message}
                </Text>
              </View>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>No log entries yet.</Text>
            }
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    // Sit above the tab bar on the left so it doesn't collide with
    // per-screen top-right chrome (grid/list toggle, etc.).
    bottom: 100,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    zIndex: 9999,
  },
  fabText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  fabCount: {
    color: "#A0A0A0",
    fontSize: 10,
    fontWeight: "500",
  },
  modal: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#333",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  headerButtons: {
    flexDirection: "row",
    gap: 8,
  },
  headerBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#222",
    borderRadius: 6,
  },
  headerBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "500",
  },
  listContent: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  row: {
    flexDirection: "row",
    paddingVertical: 3,
    gap: 8,
  },
  time: {
    color: "#606060",
    fontSize: 11,
    fontFamily: "Menlo",
    width: 90,
  },
  message: {
    flex: 1,
    fontSize: 11,
    fontFamily: "Menlo",
    lineHeight: 15,
  },
  empty: {
    color: "#606060",
    fontSize: 13,
    textAlign: "center",
    marginTop: 40,
  },
});
