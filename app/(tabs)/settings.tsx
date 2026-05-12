import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { ThemedText } from "@/src/components/ui/themed-text";
import { Surface } from "@/src/constants/theme";
import { loadCredentials, clearCredentials } from "@/src/services/credentials";
import { nvrClient } from "@/src/nvr/client";
import { useSessionStore } from "@/src/store/session-store";
import { useCameraStore } from "@/src/store/camera-store";
import { useUIStore } from "@/src/store/ui-store";
import { restorePurchases } from "@/src/services/iap";

export default function SettingsScreen() {
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const connected = useSessionStore((s) => s.connected);
  const cameraCount = useCameraStore((s) => s.cameras.length);
  const onlineCount = useCameraStore(
    (s) => s.cameras.filter((c) => c.status === "online").length,
  );
  const debugMode = useUIStore((s) => s.debugMode);
  const setDebugMode = useUIStore((s) => s.setDebugMode);
  const isPro = useUIStore((s) => s.isPro);
  const setPaywallOpen = useUIStore((s) => s.setPaywallOpen);
  const [restoring, setRestoring] = useState(false);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    try {
      await restorePurchases();
      if (!useUIStore.getState().isPro) {
        Alert.alert(
          "No purchase found",
          "We didn't find a Maple View Pro purchase on this Apple ID.",
        );
      }
    } catch {
      Alert.alert(
        "Couldn't reach the App Store",
        "Check your connection and try again.",
      );
    } finally {
      setRestoring(false);
    }
  }, []);

  // Re-load on focus so switching NVRs (logout → re-login on a new host)
  // refreshes the displayed values. Onboarding writes saveCredentials()
  // before dismissing the modal, so by the time Settings regains focus
  // SecureStore already holds the new creds. A mount-only effect would
  // miss this since the Settings tab stays mounted across the flow.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const creds = await loadCredentials();
        if (cancelled || !creds) return;
        setHost(creds.host);
        setUsername(creds.username);
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const handleLogout = () => {
    Alert.alert("Log Out", "Clear stored credentials and disconnect?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: async () => {
          await clearCredentials();
          nvrClient.disconnect();
          router.push("/onboarding");
        },
      },
    ]);
  };

  const appVersion = Constants.expoConfig?.version ?? "1.0.0";
  const buildNumber =
    Constants.expoConfig?.ios?.buildNumber ??
    Constants.expoConfig?.android?.versionCode?.toString() ??
    "1";

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <ThemedText type="title" style={styles.title}>
          Settings
        </ThemedText>

        {/* Connection info */}
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <ThemedText style={styles.infoLabel}>NVR Host</ThemedText>
            <ThemedText
              style={styles.infoValue}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {host || "—"}
            </ThemedText>
          </View>
          <View style={styles.separator} />
          <View style={styles.infoRow}>
            <ThemedText style={styles.infoLabel}>User</ThemedText>
            <ThemedText style={styles.infoValue}>{username || "—"}</ThemedText>
          </View>
          <View style={styles.separator} />
          <View style={styles.infoRow}>
            <ThemedText style={styles.infoLabel}>Status</ThemedText>
            <ThemedText
              style={[
                styles.infoValue,
                { color: connected ? Surface.success : Surface.failed },
              ]}
            >
              {connected ? "Connected" : "Disconnected"}
            </ThemedText>
          </View>
          <View style={styles.separator} />
          <View style={styles.infoRow}>
            <ThemedText style={styles.infoLabel}>Cameras</ThemedText>
            <ThemedText style={styles.infoValue}>
              {cameraCount > 0
                ? `${onlineCount} online / ${cameraCount} total`
                : "—"}
            </ThemedText>
          </View>
        </View>

        {/* Pro */}
        <View style={styles.card}>
          {isPro ? (
            <View style={styles.infoRow}>
              <ThemedText style={styles.infoLabel}>Maple View Pro</ThemedText>
              <View style={styles.proBadge}>
                <Ionicons name="checkmark-circle" size={16} color={Surface.success} />
                <ThemedText style={[styles.infoValue, styles.proBadgeText]}>
                  Unlocked
                </ThemedText>
              </View>
            </View>
          ) : (
            <>
              <Pressable
                style={styles.actionRow}
                onPress={() => setPaywallOpen(true)}
              >
                <ThemedText style={styles.actionLabel}>Upgrade to Pro</ThemedText>
                <Ionicons name="chevron-forward" size={18} color={Surface.secondaryText} />
              </Pressable>
              <View style={styles.separator} />
              <Pressable
                style={styles.actionRow}
                onPress={handleRestore}
                disabled={restoring}
              >
                <ThemedText style={styles.actionLabel}>Restore Purchases</ThemedText>
                {restoring ? (
                  <ActivityIndicator color={Surface.secondaryText} />
                ) : (
                  <Ionicons name="chevron-forward" size={18} color={Surface.secondaryText} />
                )}
              </Pressable>
            </>
          )}
        </View>

        {/* Debug */}
        <View style={styles.card}>
          <View style={styles.infoRow}>
            <ThemedText style={styles.infoLabel}>Debug Mode</ThemedText>
            <Switch
              value={debugMode}
              onValueChange={setDebugMode}
            />
          </View>
        </View>

        {/* Actions */}
        <Pressable style={styles.destructiveButton} onPress={handleLogout}>
          <ThemedText style={styles.destructiveButtonText}>Log Out</ThemedText>
        </Pressable>

        <ThemedText style={styles.version}>
          Maple View v{appVersion} ({buildNumber})
        </ThemedText>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
  },
  scroll: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    color: "#FFFFFF",
    marginBottom: 24,
    paddingTop: 8,
  },
  card: {
    backgroundColor: Surface.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
  },
  infoLabel: {
    color: Surface.secondaryText,
    fontSize: 15,
  },
  infoValue: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "500",
    flexShrink: 1,
    marginLeft: 16,
    textAlign: "right",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Surface.separator,
  },
  actionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },
  actionLabel: {
    color: "#FFFFFF",
    fontSize: 15,
  },
  proBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  proBadgeText: {
    marginLeft: 0,
    color: Surface.success,
  },
  destructiveButton: {
    backgroundColor: Surface.card,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 24,
  },
  destructiveButtonText: {
    color: Surface.destructive,
    fontSize: 17,
    fontWeight: "600",
  },
  version: {
    color: Surface.secondaryText,
    fontSize: 13,
    textAlign: "center",
  },
});
