import { useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { Ionicons } from '@expo/vector-icons';

import { NvrVideoView, type OnVideoSizePayload } from '@/modules/nvr-video-view';
import { useCamera } from '@/src/hooks/use-camera';
import { useCameraStore } from '@/src/store/camera-store';
import { nvrClient } from '@/src/nvr/client';
import { playbackManager } from '@/src/nvr/playback-manager';
import { useUIStore } from '@/src/store/ui-store';
import { ThemedText } from '@/src/components/ui/themed-text';
import { Surface } from '@/src/constants/theme';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const CHROME_TIMEOUT = 3000;
const DOUBLE_TAP_ZOOM = 2;
const SWIPE_DIST_THRESHOLD = 60;
const SWIPE_VELOCITY_THRESHOLD = 500;
const SLIDE_OUT_MS = 220;
const SLIDE_IN_MS = 220;

export default function SingleCameraScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const router = useRouter();
  const { viewRef, hasFirstFrame } = useCamera(channelId ?? '', 'main');

  const cameras = useCameraStore((s) => s.cameras);
  const cameraName =
    cameras.find((c) => c.channelId === channelId)?.name ?? 'Camera';

  // Keep screen awake
  useKeepAwake();

  // Hide tab bar and unlock rotation on mount, restore on unmount
  const tabNav = useNavigation().getParent();
  useEffect(() => {
    tabNav?.setOptions({ tabBarStyle: { display: 'none' } });
    ScreenOrientation.unlockAsync();
    return () => {
      tabNav?.setOptions({ tabBarStyle: undefined });
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.PORTRAIT_UP,
      );
    };
  }, [tabNav]);

  // ---- Chrome auto-hide ----
  const chromeVisible = useSharedValue(1);
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearChromeTimer = useCallback(() => {
    if (chromeTimerRef.current) {
      clearTimeout(chromeTimerRef.current);
      chromeTimerRef.current = null;
    }
  }, []);

  const startChromeTimer = useCallback(() => {
    clearChromeTimer();
    chromeTimerRef.current = setTimeout(() => {
      chromeVisible.value = withTiming(0, { duration: 300 });
    }, CHROME_TIMEOUT);
  }, [clearChromeTimer, chromeVisible]);

  const toggleChrome = useCallback(() => {
    if (chromeVisible.value > 0.5) {
      clearChromeTimer();
      chromeVisible.value = withTiming(0, { duration: 300 });
    } else {
      chromeVisible.value = withTiming(1, { duration: 300 });
      startChromeTimer();
    }
  }, [chromeVisible, clearChromeTimer, startChromeTimer]);

  const chromeStyle = useAnimatedStyle(() => ({
    opacity: chromeVisible.value,
    pointerEvents: chromeVisible.value > 0.5 ? 'auto' : 'none',
  }));

  // ---- Pinch / Pan / Tap gestures ----
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const { width: screenW, height: screenH } = useWindowDimensions();

  // ---- Swipe between cameras ----
  // We drive the slide manually (rather than using a stack transition) and
  // swap channelId with `router.setParams` so the screen stays mounted —
  // the useCamera hook re-attaches to the new channel as part of the re-
  // render. The ref guards against re-entry while an animation is running.
  const slideX = useSharedValue(0);
  const isSwitchingRef = useRef(false);

  const clearSwitching = useCallback(() => {
    isSwitchingRef.current = false;
  }, []);

  const applyChannelSwitch = useCallback(
    (nextChannelId: string) => {
      // Blank the native view immediately so the outgoing camera's last
      // frame doesn't show through during the slide-in. Without this, the
      // display layer keeps painting until the new stream's first keyframe
      // arrives. Pair with the solid-black loading overlay below — flush
      // covers the render gap before `hasFirstFrame` flips to false.
      viewRef.current?.flush(0).catch(() => {});
      router.setParams({ channelId: nextChannelId });
    },
    [router, viewRef],
  );

  // Jump to the Recorded tab's single-camera view for this channel.
  // Two subtleties here:
  //   1. expo-router's `router.push('/(tabs)/(playback)/camera/X')` stacks
  //      onto the *current* tab's navigator instead of switching tabs — so
  //      we dispatch a React Navigation nested-navigate on the parent Tabs
  //      nav to actually switch to (playback).
  //   2. React Navigation 7's default for nested-navigate is "specified
  //      screen becomes the navigator's initial route" — which leaves the
  //      (playback) Stack as [camera/X] with no grid underneath, and Back
  //      pops out of the tab entirely instead of landing on the grid.
  //      Passing `initial: false` tells the Stack to respect its real
  //      initial route (index.tsx / grid) and push camera/X on top of it.
  const openRecordings = useCallback(() => {
    if (!channelId) return;
    tabNav?.navigate('(playback)', {
      screen: 'camera/[channelId]',
      params: { channelId },
      initial: false,
    });
  }, [channelId, tabNav]);

  // Stable reference for the down-swipe handler — runOnJS loses `this`
  // binding if passed `router.back` directly, so we wrap.
  const goBackToGrid = useCallback(() => {
    router.back();
  }, [router]);

  const switchCamera = useCallback(
    (dir: 1 | -1) => {
      if (isSwitchingRef.current) return;
      if (cameras.length < 2 || !channelId) return;
      const idx = cameras.findIndex((c) => c.channelId === channelId);
      if (idx < 0) return;
      const next = cameras[(idx + dir + cameras.length) % cameras.length];
      if (next.channelId === channelId) return;

      isSwitchingRef.current = true;
      const outTarget = dir === 1 ? -screenW : screenW;
      const inStart = -outTarget;
      slideX.value = withTiming(
        outTarget,
        { duration: SLIDE_OUT_MS },
        (finished) => {
          'worklet';
          if (!finished) {
            slideX.value = 0;
            runOnJS(clearSwitching)();
            return;
          }
          runOnJS(applyChannelSwitch)(next.channelId);
          slideX.value = inStart;
          slideX.value = withTiming(0, { duration: SLIDE_IN_MS }, () => {
            'worklet';
            runOnJS(clearSwitching)();
          });
        },
      );
    },
    [cameras, channelId, screenW, slideX, applyChannelSwitch, clearSwitching],
  );

  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: slideX.value }],
  }));

  // Viewport size — measured from the video container via onLayout so the
  // clamp matches the actual displayed area (not the full screen).
  const viewportW = useSharedValue(screenW);
  const viewportH = useSharedValue(screenH);

  // Actual stream aspect ratio, reported by the native view once the SPS
  // is parsed (presentation dimensions, so anamorphic streams come out
  // right). Defaults to 16:9 until the first keyframe lands. Sub-streams
  // are often 4:3 — hardcoding 16:9 here made the clamp think the image
  // was shorter than displayed, leaving its top/bottom unreachable when
  // zoomed. Not reset on channel switch: the native side re-emits
  // whenever the dimensions actually change.
  const videoAR = useSharedValue(16 / 9);
  const handleVideoSize = useCallback(
    (e: { nativeEvent: OnVideoSizePayload }) => {
      const { width, height } = e.nativeEvent;
      if (width > 0 && height > 0) videoAR.value = width / height;
    },
    [videoAR],
  );

  // Safe-area insets re-resolve on rotation; the gesture worklets are
  // rebuilt on that re-render, so capturing the plain numbers is safe.
  const insets = useSafeAreaInsets();

  const clampTranslate = (
    tx: number,
    ty: number,
    s: number,
  ): [number, number] => {
    'worklet';
    // Compute the fit-inside displayed size of the video within the
    // viewport (letterbox/pillarbox), then clamp the translation so the
    // scaled content never exposes background past the viewport edge —
    // matching iOS Photos behavior, except each edge may over-pan up to
    // the safe-area inset so it can be pulled out from under the dynamic
    // island / curved corners.
    const ar = videoAR.value;
    const vw = viewportW.value;
    const vh = viewportH.value;
    const viewportAR = vw / vh;
    const contentW = viewportAR > ar ? vh * ar : vw;
    const contentH = viewportAR > ar ? vh : vw / ar;
    // Signed overflow per axis — negative means the image fits with a gap.
    // max(0, raw + inset) lets each edge reach exactly the safe-area
    // boundary: a full inset of over-pan when the axis overflows,
    // decaying to zero as the fit gap grows past the inset. Flooring the
    // overflow before adding the inset would instead lock panning at
    // scales where the image fits the axis but its edge sits inside the
    // inset zone (16:9 landscape at ~1.0–1.2x), trapping the edge under
    // the notch. Positive tx reveals the image's left edge, so it pairs
    // with the left inset (and vice versa); same logic vertically.
    const rawX = (contentW * s - vw) / 2;
    const rawY = (contentH * s - vh) / 2;
    return [
      Math.min(
        Math.max(0, rawX + insets.left),
        Math.max(-Math.max(0, rawX + insets.right), tx),
      ),
      Math.min(
        Math.max(0, rawY + insets.top),
        Math.max(-Math.max(0, rawY + insets.bottom), ty),
      ),
    ];
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
      scale.value = next;

      const [cx, cy] = clampTranslate(
        savedTranslateX.value,
        savedTranslateY.value,
        next,
      );
      translateX.value = cx;
      translateY.value = cy;
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(2)
    .onUpdate((e) => {
      if (scale.value <= 1) return;
      const nextX = savedTranslateX.value + e.translationX;
      const nextY = savedTranslateY.value + e.translationY;
      const [cx, cy] = clampTranslate(nextX, nextY, scale.value);
      translateX.value = cx;
      translateY.value = cy;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1.05) {
        // Reset to 1x
        scale.value = withTiming(1, { duration: 250 });
        savedScale.value = 1;
        translateX.value = withTiming(0, { duration: 250 });
        translateY.value = withTiming(0, { duration: 250 });
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        // Zoom to 2x
        scale.value = withTiming(DOUBLE_TAP_ZOOM, { duration: 250 });
        savedScale.value = DOUBLE_TAP_ZOOM;
        translateX.value = 0;
        translateY.value = 0;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(toggleChrome)();
    });

  // Horizontal swipe to switch cameras. Bails on end when zoomed — the
  // main pan gesture above is handling 2D panning of the image instead.
  // activeOffsetX/failOffsetY keep it from competing with vertical drags
  // or pinch.
  const swipePan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .activeOffsetX([-20, 20])
    .failOffsetY([-16, 16])
    .onEnd((e) => {
      if (scale.value > 1.01) return;
      if (
        e.translationX <= -SWIPE_DIST_THRESHOLD ||
        e.velocityX < -SWIPE_VELOCITY_THRESHOLD
      ) {
        runOnJS(switchCamera)(1);
      } else if (
        e.translationX >= SWIPE_DIST_THRESHOLD ||
        e.velocityX > SWIPE_VELOCITY_THRESHOLD
      ) {
        runOnJS(switchCamera)(-1);
      }
    });

  // Downward swipe to close the single-camera screen. Activates only on
  // downward Y motion past 16px and fails on any horizontal motion past
  // 16px, so it stays mutually exclusive with swipePan (horizontal) and
  // doesn't fight pinch or zoomed-image panning. Like swipePan, bails on
  // end when zoomed so the user can still vertical-pan inside a zoom.
  const downSwipe = Gesture.Pan()
    .minPointers(1)
    .maxPointers(1)
    .activeOffsetY(16)
    .failOffsetX([-16, 16])
    .onEnd((e) => {
      if (scale.value > 1.01) return;
      if (
        e.translationY >= SWIPE_DIST_THRESHOLD ||
        e.velocityY > SWIPE_VELOCITY_THRESHOLD
      ) {
        runOnJS(goBackToGrid)();
      }
    });

  // Taps are mutually exclusive with doubleTap taking priority: singleTap
  // is recognized only once doubleTap fails (~200ms after a lone tap), so
  // double-tap-to-zoom works and a single tap toggles the chrome. A flat
  // Race(doubleTap, singleTap) would let singleTap activate on the first
  // touch-up and cancel doubleTap every time (1-tap handlers go ACTIVE
  // immediately on release).
  const composed = Gesture.Race(
    Gesture.Simultaneous(pinch, pan, swipePan, downSwipe),
    Gesture.Exclusive(doubleTap, singleTap),
  );

  // Reset zoom/pan when the channel changes via swipe (same screen, new
  // param — no remount, so zoom state would otherwise leak across cameras).
  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [channelId, scale, savedScale, translateX, translateY, savedTranslateX, savedTranslateY]);

  const animatedVideoStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // ---- Error / disconnect state ----
  // We rely on the camera store status for disconnect detection
  const cameraStatus = useCameraStore((s) => {
    const cam = s.cameras.find((c) => c.channelId === channelId);
    return cam?.status ?? 'connecting';
  });
  // During background → foreground recovery the manager is tearing down
  // and reopening every stream; individual channels can transition
  // through 'failed' on their retry chain before the fresh opens land.
  // Suppress per-camera failure states in that window so the Retry
  // overlay doesn't flash during what's functionally a reconnect.
  // Mirrors the grid tile's effectiveStatus guard in camera-tile.tsx.
  const reconnecting = useCameraStore((s) => s.reconnecting);
  const effectiveStatus = reconnecting ? 'connecting' : cameraStatus;

  const isDisconnected =
    effectiveStatus === 'offline' || effectiveStatus === 'failed';

  // Show chrome on mount, then auto-hide. While the disconnect overlay is
  // up, force the bar visible and cancel the timer: the overlay sits over
  // the gesture layer, so tap-to-show couldn't fire and Back would be
  // unreachable behind a hidden bar.
  useEffect(() => {
    if (isDisconnected) {
      clearChromeTimer();
      chromeVisible.value = withTiming(1, { duration: 300 });
    } else {
      startChromeTimer();
    }
    return clearChromeTimer;
  }, [isDisconnected, chromeVisible, startChromeTimer, clearChromeTimer]);

  const handleRetry = useCallback(() => {
    if (!channelId) return;
    // hardRetry tears down live + playback state and does a fresh login,
    // matching force-quit semantics. closeAllStreams inside hardRetry
    // sets cameraStore.reconnecting which already shrouds this screen,
    // so no explicit updateStatus is needed. See NVRClient.hardRetry.
    nvrClient.hardRetry();
  }, [channelId]);

  const hqMode = useUIStore((s) => s.hqMode);
  const setHqMode = useUIStore((s) => s.setHqMode);
  const handleHqToggle = useCallback(() => {
    setHqMode(!hqMode);
    // Live: walks the single main-mode stream (this camera) and reopens
    // it at the new stream_index. Playback: flip takes effect on any
    // currently-open playback connections for when the user jumps over.
    nvrClient.liveHqModeChanged();
    playbackManager.hqModeChanged();
  }, [hqMode, setHqMode]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <Animated.View style={[styles.slideWrap, slideStyle]}>
        <GestureDetector gesture={composed}>
          <Animated.View
            style={[styles.videoContainer, animatedVideoStyle]}
            onLayout={(e) => {
              viewportW.value = e.nativeEvent.layout.width;
              viewportH.value = e.nativeEvent.layout.height;
            }}
          >
            <NvrVideoView
              ref={viewRef}
              backgroundHex="#000000"
              onVideoSize={handleVideoSize}
              style={styles.video}
            />
          </Animated.View>
        </GestureDetector>

        {/* Loading spinner — also covers the gap between mount and first
            frame, where the native view is still black but status may
            already read "online" (from enumerate). */}
        {(effectiveStatus === 'connecting' || (!isDisconnected && !hasFirstFrame)) && (
          // pointerEvents none so taps/swipes still reach the gesture
          // layer underneath — chrome toggle, camera swipe, and
          // swipe-down-to-close keep working while connecting.
          <View style={styles.loadingOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#FFFFFF" />
          </View>
        )}

        {/* Disconnect overlay */}
        {isDisconnected && (
          <View style={styles.disconnectOverlay}>
            <ThemedText style={styles.disconnectText}>Disconnected</ThemedText>
            <Pressable style={styles.retryButton} onPress={handleRetry}>
              <ThemedText style={styles.retryText}>Retry</ThemedText>
            </Pressable>
          </View>
        )}

        {/* Chrome: top bar */}
        <Animated.View style={[styles.chrome, chromeStyle]}>
          <View style={styles.topBar}>
            <Pressable
              onPress={() => router.back()}
              style={styles.backButton}
              hitSlop={16}
            >
              <ThemedText style={styles.backText}>{'‹ Back'}</ThemedText>
            </Pressable>
            <ThemedText style={styles.cameraName} numberOfLines={1}>
              {cameraName}
            </ThemedText>
            <Pressable
              onPress={handleHqToggle}
              style={styles.hqPill}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 6 }}
              accessibilityLabel={hqMode ? 'Switch to LQ (lower-resolution stream)' : 'Switch to HQ (full-resolution stream)'}
            >
              <ThemedText style={styles.hqPillText}>
                {hqMode ? 'HQ' : 'LQ'}
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={openRecordings}
              style={styles.recordingsButton}
              hitSlop={16}
              accessibilityLabel="View recordings for this camera"
            >
              <Ionicons name="film-outline" size={24} color="#FFFFFF" />
            </Pressable>
          </View>
        </Animated.View>
      </Animated.View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  slideWrap: {
    flex: 1,
  },
  videoContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  chrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  backButton: {
    paddingRight: 12,
  },
  backText: {
    fontSize: 17,
    color: '#FFFFFF',
    fontWeight: '500',
  },
  cameraName: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  recordingsButton: {
    width: 60,
    alignItems: 'flex-end',
    paddingLeft: 12,
  },
  hqPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FFFFFF',
    backgroundColor: 'transparent',
    marginRight: 12,
  },
  hqPillText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: '#FFFFFF',
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  disconnectOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  disconnectText: {
    fontSize: 18,
    fontWeight: '600',
    color: Surface.secondaryText,
    marginBottom: 16,
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: Surface.card,
    borderRadius: 8,
  },
  retryText: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '500',
  },
});
