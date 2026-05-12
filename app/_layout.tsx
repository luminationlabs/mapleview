import {
  CommonActions,
  DarkTheme,
  StackActions,
  ThemeProvider,
} from "@react-navigation/native";
import { Stack, router, useNavigationContainerRef } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import {
  configureReanimatedLogger,
  ReanimatedLogLevel,
} from "react-native-reanimated";

import { loadCredentials } from "@/src/services/credentials";
import { nvrClient, isAuthFailure } from "@/src/nvr/client";
import { cameraStore, loadSavedOrder } from "@/src/store/camera-store";
import { useSessionStore } from "@/src/store/session-store";
import { useUIStore } from "@/src/store/ui-store";
import { useAppLifecycle } from "@/src/hooks/use-app-lifecycle";
import { installConsoleInterceptor } from "@/src/utils/debug-log";
import { DebugLogOverlay } from "@/src/components/debug-log-overlay";
import { PaywallSheet } from "@/src/components/paywall-sheet";
import { initialize as initializeIAP, syncEntitlement } from "@/src/services/iap";
import { Surface } from "@/src/constants/theme";

// Mirror console.* into the in-app debug overlay as early as possible so
// startup logs (login, enumerate) are captured even in release builds.
installConsoleInterceptor();

// TODO: Remove this (to keep strict mode on) when we've fixed the reanimated warnings
configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false, // Reanimated runs in strict mode by default
});

const darkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "#000000",
    card: "#000000",
    border: Surface.separator,
  },
};

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const authFailed = useSessionStore((s) => s.authFailed);
  const navRef = useNavigationContainerRef();

  // App lifecycle management (background/foreground transitions). After a
  // long background (>5 min) we send the user back to the Live grid —
  // they've clearly moved on, so whatever screen they had pushed before
  // backgrounding shouldn't stick around. We do this with targeted pop
  // actions rather than CommonActions.reset because reset regenerates
  // route keys, causing the outer Stack to remount and animate a push
  // even when the state was already at the target.
  const handleColdReset = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const rootState = nav.getRootState();
    if (!rootState) return;

    // Dismiss any outer-stack modal (e.g. onboarding) back to (tabs).
    if (rootState.index > 0) {
      nav.dispatch(StackActions.popToTop());
    }

    // Pop each inner tab stack back to its grid root, so a pushed
    // single-cam view doesn't survive the resume.
    const tabsRoute = rootState.routes.find((r) => r.name === "(tabs)");
    const tabsState = tabsRoute?.state;
    const innerTabs = tabsState?.routes ?? [];
    for (const tab of innerTabs) {
      const s = tab.state;
      if (s?.key && s.routes && s.routes.length > 1) {
        nav.dispatch({
          ...StackActions.popToTop(),
          target: s.key,
        });
      }
    }

    // Switch back to the Live tab if the user was on a different tab.
    if (tabsState) {
      const activeTab = tabsState.routes[tabsState.index ?? 0];
      if (activeTab && activeTab.name !== "(live)") {
        nav.dispatch(CommonActions.navigate("(live)"));
      }
    }
  }, [navRef]);
  useAppLifecycle({ onColdReset: handleColdReset });

  // Wire up credential loader for auth recovery
  useEffect(() => {
    nvrClient.setCredentialLoader(loadCredentials);
    // Live HQ provider — parallels the playback side, but installed at the
    // root so it's active even before the (playback) tab layout mounts.
    nvrClient.setHqModeProvider(() => useUIStore.getState().hqMode);
  }, []);

  // Boot IAP: connect to StoreKit and re-sync the cached Pro flag against
  // current entitlements (catches cross-device restores and refunds).
  useEffect(() => {
    (async () => {
      try {
        await initializeIAP();
        await syncEntitlement();
      } catch {
        // App keeps running in cached-state Lite/Pro if StoreKit is down.
      }
    })();
  }, []);

  // Navigate to onboarding when authFailed is set
  useEffect(() => {
    if (!ready || !authFailed) return;

    const { sessionStore } = require("@/src/store/session-store");
    const state = sessionStore.getState();
    const prefillHost = state.host ?? "";

    // Reset authFailed so we don't loop
    state.setAuthFailed(false);

    setTimeout(() => {
      router.push({
        pathname: "/onboarding",
        params: {
          prefillHost,
          prefillUsername: "",
          fromSettings: "false",
          loginFailed: "true",
        },
      });
    }, 0);
  }, [authFailed, ready]);

  useEffect(() => {
    (async () => {
      try {
        // Load saved camera order before connecting
        const savedOrder = await loadSavedOrder();
        if (savedOrder) {
          cameraStore.getState().setSavedOrder(savedOrder);
        }

        const creds = await loadCredentials();
        if (!creds) {
          // No credentials stored - show onboarding
          setReady(true);
          setTimeout(() => {
            router.push("/onboarding");
          }, 0);
          return;
        }

        // Single connect attempt. We distinguish the outcome:
        //
        //  - Success: app mounts with cameras populated.
        //  - Auth failure (doLogin rejected): credentials are actually
        //    bad → pop onboarding immediately with loginFailed so the
        //    user can re-enter them.
        //  - Transport failure (network not ready, NVR unreachable, HTTP
        //    5xx, etc.): hand off to the reconnect backoff loop. The
        //    app mounts to the main UI with a "Connecting…" banner and
        //    connects as soon as the network is back. If the transport
        //    issue eventually turns out to be bad creds, attemptReconnect
        //    will set authFailed and the watcher above navigates to
        //    onboarding.
        //
        // Previously this did 3 retries with a 1s backoff and then
        // unconditionally popped onboarding — which made a slow network
        // on cold launch (phone just unlocked, WiFi re-associating,
        // Local Network permission prompt pending, iOS app-killed
        // resume) look like "please log in again" to the user.
        try {
          await nvrClient.connect(creds.host, creds.username, creds.password);
        } catch (err) {
          if (isAuthFailure(err)) {
            setReady(true);
            setTimeout(() => {
              router.push({
                pathname: "/onboarding",
                params: {
                  prefillHost: creds.host,
                  prefillUsername: creds.username,
                  fromSettings: "false",
                  loginFailed: "true",
                },
              });
            }, 0);
            return;
          }
          nvrClient.startReconnect();
        }
      } catch {
        // loadCredentials / loadSavedOrder failed - show onboarding
        setReady(true);
        setTimeout(() => {
          router.push("/onboarding");
        }, 0);
        return;
      }
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#FFFFFF" />
      </View>
    );
  }

  return (
    <ThemeProvider value={darkTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="onboarding"
          options={{
            presentation: "fullScreenModal",
            headerShown: false,
            gestureEnabled: false,
          }}
        />
      </Stack>
      <StatusBar style="light" />
      <DebugLogOverlay />
      <PaywallSheet />
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
});
