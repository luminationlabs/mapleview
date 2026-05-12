import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";

import { ThemedText } from "@/src/components/ui/themed-text";
import { Surface } from "@/src/constants/theme";
import { nvrClient } from "@/src/nvr/client";
import { saveCredentials, clearCredentials, loadHost } from "@/src/services/credentials";
import { parseHost } from "@/src/utils/parse-host";
import { DebugLogOverlay } from "@/src/components/debug-log-overlay";

export default function OnboardingScreen() {
  const params = useLocalSearchParams<{
    prefillHost?: string;
    prefillUsername?: string;
    fromSettings?: string;
    loginFailed?: string;
  }>();

  const fromSettings = params.fromSettings === "true";
  const loginFailed = params.loginFailed === "true";

  const [host, setHost] = useState(params.prefillHost ?? "");
  const [username, setUsername] = useState(params.prefillUsername ?? "");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(
    loginFailed
      ? "Previous login expired. Please re-enter your password."
      : null,
  );

  // Clear stale error when inputs change
  useEffect(() => {
    setError(null);
  }, [host, username, password]);

  // If no host was passed in via navigation params, fall back to the last
  // saved host. clearCredentials() keeps the host around precisely so we can
  // prefill it here after logout.
  useEffect(() => {
    if (params.prefillHost) return;
    let cancelled = false;
    (async () => {
      const saved = await loadHost();
      if (!cancelled && saved) setHost((h) => (h.length === 0 ? saved : h));
    })();
    return () => { cancelled = true; };
  }, [params.prefillHost]);

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    const parsedHost = parseHost(host);

    try {
      // connect() performs the login internally and throws on failure — so we
      // save the credentials only after it succeeds, and a wrong password
      // never overwrites a previously-working stored one.
      await nvrClient.connect(parsedHost, username, password);
      await saveCredentials(parsedHost, username, password);
      router.dismiss();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Network") ||
        msg.includes("request failed") ||
        msg.includes("reqLogin failed")
      ) {
        setError("Can't reach NVR");
      } else if (msg.includes("doLogin")) {
        const nvrDetail = msg
          .replace(/^doLogin:\s*/, "")
          .replace(/^doLogin failed:\s*/, "");
        setError(nvrDetail || "Wrong username or password");
      } else {
        setError(msg);
      }
      setConnecting(false);
    }
  };

  const handleCancel = () => {
    router.dismiss();
  };

  const handleLogout = async () => {
    await clearCredentials();
    nvrClient.disconnect();
    // Reset form — keep host so the user doesn't have to retype the NVR
    // address to log back in.
    setUsername("");
    setPassword("");
    setError(null);
  };

  const canConnect =
    host.trim().length > 0 && username.trim().length > 0 && password.length > 0;

  const { width } = useWindowDimensions();
  const isWide = width >= 600;

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            isWide && styles.scrollWide,
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.container, isWide && styles.containerWide]}>
            <ThemedText type="title" style={styles.title}>
              Connect to NVR
            </ThemedText>
            <ThemedText style={styles.subtitle}>
              Enter your NVR connection details below.
            </ThemedText>

            <View style={styles.card}>
              <ThemedText style={styles.label}>NVR Host</ThemedText>
              <TextInput
                style={styles.input}
                value={host}
                onChangeText={setHost}
                placeholder="192.168.1.100 or https://nvr.example.com"
                placeholderTextColor={Surface.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="next"
              />

              <ThemedText style={styles.label}>Username</ThemedText>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                placeholder="admin"
                placeholderTextColor={Surface.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />

              <ThemedText style={styles.label}>Password</ThemedText>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="password"
                placeholderTextColor={Surface.placeholder}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
              />

              {error && <ThemedText style={styles.error}>{error}</ThemedText>}

              <Pressable
                style={[
                  styles.connectButton,
                  (!canConnect || connecting) && styles.buttonDisabled,
                ]}
                onPress={handleConnect}
                disabled={!canConnect || connecting}
              >
                {connecting ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
                ) : (
                  <ThemedText style={styles.connectButtonText}>
                    Connect
                  </ThemedText>
                )}
              </Pressable>
            </View>

            {fromSettings && (
              <Pressable style={styles.cancelButton} onPress={handleCancel}>
                <ThemedText style={styles.cancelButtonText}>Cancel</ThemedText>
              </Pressable>
            )}

            {loginFailed && (
              <Pressable style={styles.logoutButton} onPress={handleLogout}>
                <ThemedText style={styles.logoutButtonText}>Log Out</ThemedText>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <DebugLogOverlay />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
  },
  flex: {
    flex: 1,
  },
  scroll: {
    padding: 16,
    paddingTop: 60,
    paddingBottom: 40,
  },
  scrollWide: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingTop: 40,
  },
  container: {
    width: "100%",
  },
  containerWide: {
    maxWidth: 480,
    alignSelf: "center",
  },
  title: {
    color: "#FFFFFF",
    marginBottom: 8,
  },
  subtitle: {
    color: Surface.secondaryText,
    fontSize: 16,
    marginBottom: 32,
  },
  card: {
    backgroundColor: Surface.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  label: {
    color: Surface.secondaryText,
    fontSize: 13,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: Surface.input,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: "#FFFFFF",
  },
  error: {
    color: Surface.error,
    fontSize: 14,
    marginTop: 12,
  },
  connectButton: {
    backgroundColor: "#0A84FF",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 20,
  },
  connectButtonText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  cancelButton: {
    backgroundColor: Surface.card,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 12,
  },
  cancelButtonText: {
    color: Surface.secondaryText,
    fontSize: 17,
    fontWeight: "600",
  },
  logoutButton: {
    backgroundColor: Surface.card,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 12,
  },
  logoutButtonText: {
    color: Surface.destructive,
    fontSize: 17,
    fontWeight: "600",
  },
});
