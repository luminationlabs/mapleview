import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/src/components/ui/themed-text';
import { useSessionStore } from '@/src/store/session-store';
import { nvrClient } from '@/src/nvr/client';
import { Surface } from '@/src/constants/theme';

const TOP_BAR_HEIGHT = 44;
const HIDDEN_OFFSET = -80;

/**
 * Connection-state overlay. Renders absolutely-positioned below the top bar
 * so it doesn't affect the grid layout when it appears or disappears.
 *
 * - Connecting / Reconnecting: shows a subtle "Connecting..." (with attempt
 *   count if available). No action — we're already trying.
 * - Disconnected (no active try): shows "Can't reach NVR" with a Retry button.
 * - Connected: hidden.
 *
 * Replaces the previous in-flow status row, which caused layout shift each
 * time it appeared, and the standalone disconnect banner — both consolidated
 * here so they can't render simultaneously.
 */
export function DisconnectBanner() {
  const connected = useSessionStore((s) => s.connected);
  const connecting = useSessionStore((s) => s.connecting);
  const reconnecting = useSessionStore((s) => s.reconnecting);
  const attemptCount = useSessionStore((s) => s.attemptCount);
  const insets = useSafeAreaInsets();

  const isTrying = (connecting || reconnecting) && !connected;
  const isFailed = !connected && !connecting && !reconnecting;
  const shouldShow = isTrying || isFailed;

  const translateY = useSharedValue(shouldShow ? 0 : HIDDEN_OFFSET);
  const opacity = useSharedValue(shouldShow ? 1 : 0);

  useEffect(() => {
    translateY.value = withTiming(shouldShow ? 0 : HIDDEN_OFFSET, { duration: 250 });
    opacity.value = withTiming(shouldShow ? 1 : 0, { duration: 250 });
  }, [shouldShow, translateY, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  if (!shouldShow && translateY.value <= HIDDEN_OFFSET + 1) {
    return null;
  }

  const handleRetry = () => {
    // hardRetry tears down all live/playback state and does a fresh
    // login, matching force-quit semantics. retryNow only re-runs the
    // login + reopenStreams path, which leaves stale extras and half-open
    // sockets that are the root cause of "retry does not recover but
    // force-quit does" — see NVRClient.hardRetry for the full list.
    nvrClient.hardRetry();
  };

  return (
    <Animated.View
      style={[styles.banner, { top: insets.top + TOP_BAR_HEIGHT }, animatedStyle]}
      pointerEvents={isFailed ? 'auto' : 'none'}
    >
      <View style={styles.textContainer}>
        {isTrying ? (
          <ThemedText style={styles.tryingText}>
            {reconnecting && attemptCount > 0
              ? `Reconnecting (attempt ${attemptCount})...`
              : 'Connecting...'}
          </ThemedText>
        ) : (
          <ThemedText style={styles.failedText}>Can&apos;t reach NVR</ThemedText>
        )}
      </View>
      {isFailed && (
        <Pressable style={styles.retryButton} onPress={handleRetry}>
          <ThemedText style={styles.retryText}>Retry Now</ThemedText>
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Surface.card,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Surface.separator,
    zIndex: 100,
  },
  textContainer: {
    flex: 1,
    marginRight: 12,
  },
  tryingText: {
    fontSize: 14,
    color: Surface.secondaryText,
  },
  failedText: {
    fontSize: 14,
    fontWeight: '600',
    color: Surface.error,
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: Surface.input,
    borderRadius: 6,
  },
  retryText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
  },
});
