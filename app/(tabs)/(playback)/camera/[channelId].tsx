import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { Ionicons } from '@expo/vector-icons';

import { NvrVideoView } from '@/modules/nvr-video-view';
import { usePlayback } from '@/src/hooks/use-playback';
import { useCameraStore, cameraStore } from '@/src/store/camera-store';
import { usePlaybackStore, playbackStore, segmentCoveringTime } from '@/src/store/playback-store';
import { useSessionStore } from '@/src/store/session-store';
import { playbackManager } from '@/src/nvr/playback-manager';
import { nvrClient } from '@/src/nvr/client';
import { queryChlRecLogFresh, queryDatesExistRecFresh } from '@/src/nvr/query-helpers';
import { DatePickerModal } from '@/src/components/date-picker-modal';
import { Timeline } from '@/src/components/timeline';
import { TransportControls } from '@/src/components/transport-controls';
import { usePlaybackRateOverlay } from '@/src/components/playback-rate-overlay';
import { useUIStore } from '@/src/store/ui-store';
import { dayToUnixRange, projectTimeOntoDay, unixToUtcTimeStr, utcTimeStrToUnix } from '@/src/utils/time';
import { formatDateLabel } from '@/src/utils/date-label';
import { useTimelineAutoRefresh } from '@/src/hooks/use-timeline-refresh';
import { ThemedText } from '@/src/components/ui/themed-text';
import { Surface } from '@/src/constants/theme';
import type { CameraInfo, RecordingSegment, TimeRange } from '@/src/nvr/types';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_ZOOM = 2;
const SWIPE_DIST_THRESHOLD = 60;
const SWIPE_VELOCITY_THRESHOLD = 500;
const SLIDE_OUT_MS = 220;
const SLIDE_IN_MS = 220;

/** Pick the playback start on the swipe-target camera: keep `preferred` if
 *  it falls inside a segment, otherwise snap to the nearest segment edge.
 *  Returns null if the camera has no segments for the day. */
function pickTargetTime(
  segments: RecordingSegment[],
  preferred: number,
): number | null {
  if (!segments || segments.length === 0) return null;
  let nearest: number | null = null;
  let nearestDist = Infinity;
  for (const seg of segments) {
    const start = utcTimeStrToUnix(seg.startTime);
    const end = utcTimeStrToUnix(seg.endTime);
    if (preferred >= start && preferred <= end) return preferred;
    const candidate = preferred < start ? start : end;
    const dist = Math.abs(candidate - preferred);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = candidate;
    }
  }
  return nearest;
}

export default function PlaybackCameraScreen() {
  const { channelId } = useLocalSearchParams<{ channelId: string }>();
  const router = useRouter();
  const { onFrame: onRateOverlayFrame, overlay: rateOverlay } = usePlaybackRateOverlay();
  const { viewRef, hasFirstFrame } = usePlayback(channelId ?? '', 'main', onRateOverlayFrame);
  const hqMode = useUIStore((s) => s.hqMode);
  const setHqMode = useUIStore((s) => s.setHqMode);
  const handleHqToggle = useCallback(() => {
    setHqMode(!hqMode);
    playbackManager.hqModeChanged();
    nvrClient.liveHqModeChanged();
  }, [hqMode, setHqMode]);
  const insets = useSafeAreaInsets();

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

  // Close the grid's 11 other channels while single-cam is on top. Every
  // `seekAll` otherwise restarts 12 tasks; a pacing edge case on any one
  // of them can trip the 5s loading watchdog and produce a stuck/reopen
  // cascade. Reopen on unmount at the current playhead so the grid
  // resumes where the user was watching.
  //
  // Swipe-between-cameras (channelId change) re-runs this: applyChannelSwitch
  // closeAll+openAll leaves only one connection by the time the new effect
  // fires, so closeAllExcept becomes a no-op in that path.
  useEffect(() => {
    if (!channelId) return;
    playbackManager.closeAllExcept(channelId);
    return () => {
      playbackManager.reopenAllExcept(channelId);
    };
  }, [channelId]);

  // ---- Playback state ----
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const speed = usePlaybackStore((s) => s.speed);
  const selectedDate = usePlaybackStore((s) => s.selectedDate);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setSpeed = usePlaybackStore((s) => s.setSpeed);
  const setSelectedDate = usePlaybackStore((s) => s.setSelectedDate);
  const setCameraSegments = usePlaybackStore((s) => s.setCameraSegments);
  const setLoadingSegments = usePlaybackStore((s) => s.setLoadingSegments);
  const loadingSegments = usePlaybackStore((s) => s.loadingSegments);

  const host = useSessionStore((s) => s.host);
  const token = useSessionStore((s) => s.token);
  const sessionIdStr = useSessionStore((s) => s.sessionId);

  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [availableDates, setAvailableDates] = useState<Set<string>>(new Set());
  // Mirrors availableDates into a ref so the background refresh can
  // read the current size without taking it as a useCallback dep
  // (which would churn the callback on every dates update).
  const availableDatesRef = useRef(availableDates);
  availableDatesRef.current = availableDates;
  // Mirrors the current channelId so the background refresh can detect
  // a mid-flight camera swipe (router.setParams changes channelId
  // without remounting). Writes to screen-local state like
  // setAvailableDates would otherwise apply the old camera's data to
  // the new camera's screen.
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  // True when the playback connection's retry chain exhausted without
  // receiving any frame (e.g., stale-session HTTP 400 on WS upgrade that
  // outlived the auto-recovery path). Distinct from initFailed, which
  // is only set on the deep-link init path.
  const channelFailed = usePlaybackStore(
    (s) => s.failedChannels[channelId ?? ''] ?? false,
  );
  // True when the deep-link init couldn't populate recordings (error or
  // empty response). Drives the retry overlay.
  const [initFailed, setInitFailed] = useState(false);
  // Bumped by the retry button to force the init effect to re-run.
  const [retryCounter, setRetryCounter] = useState(0);

  // Helper: read the freshest available session after any in-flight logins
  // settle. sessionStore values can be stale the moment an extra-session
  // login completes (the NVR invalidates earlier HTTP tokens), so for
  // HTTP queries we always go through awaitPendingLogins + the live
  // latest-session getters.
  const getFreshSession = useCallback(async () => {
    await nvrClient.awaitPendingLogins();
    return playbackManager.latestSession ?? nvrClient.latestSession;
  }, []);

  // Fetch available dates for this camera
  useEffect(() => {
    if (!host || !token || !sessionIdStr || !channelId) return;
    let cancelled = false;

    (async () => {
      try {
        const s = await getFreshSession();
        if (cancelled || !s) return;
        // queryDatesExistRecFresh retries with a fresher token if the
        // first result was empty and another login has since landed.
        const info = await queryDatesExistRecFresh(channelId);
        if (!cancelled) {
          setAvailableDates(new Set(info.dates));
        }
      } catch (err) {
        console.log('[playback-camera] failed to fetch available dates:', err instanceof Error ? err.message : err);
      }
    })();

    return () => { cancelled = true; };
  }, [host, token, sessionIdStr, channelId, getFreshSession]);

  // Deep-link init: if we arrived here without the grid having opened
  // streams (cold-launch into this screen, or direct nav from the Live
  // single-camera view), nothing is playing yet and the PlaybackManager
  // has no connection for this channel. Query segments for the selected
  // date and open a main-stream connection at the earliest segment.
  //
  // When we arrived via the grid, a connection already exists and
  // usePlayback's attach() handles the mode upgrade to "main"; this
  // effect becomes a no-op because `hasConnection` is true.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!channelId || !host || !token || !sessionIdStr) return;
    if (initializedRef.current) return;
    // If the grid already opened connections (reached via the grid path),
    // skip. playbackManager.attach() handles the sink swap + mode upgrade.
    if (playbackManager.getSink(channelId) != null || playbackStore.getState().cameraSegments[channelId]?.length) {
      // Segments already queried — good enough signal that init has run
      // somewhere. Don't re-query or reopen.
      initializedRef.current = true;
      return;
    }
    initializedRef.current = true;
    let cancelled = false;
    setInitFailed(false);

    (async () => {
      setLoadingSegments(true);
      const { end: dayEnd } = dayToUnixRange(selectedDate);
      const startTimeStr = `${selectedDate} 00:00:00`;
      const endTimeStr = `${selectedDate} 23:59:59`;
      try {
        const s = await getFreshSession();
        if (cancelled) return;
        if (!s) {
          setInitFailed(true);
          return;
        }
        // queryChlRecLogFresh retries once with a fresher token if the
        // first result came back empty and another login landed in the
        // meantime — catches the silent-empty-on-invalidated-token case.
        const segs = await queryChlRecLogFresh(
          channelId,
          startTimeStr,
          endTimeStr,
        );
        if (cancelled) return;
        setCameraSegments(channelId, segs);
        if (segs.length === 0) {
          // Empty segments could be legitimate (no recordings that day)
          // or a stale-token silent failure. Surface it as a retryable
          // init failure — the retry button will requery with a fresh
          // session, and if there really are no recordings the overlay
          // just reappears.
          setInitFailed(true);
          return;
        }
        const cam = cameraStore.getState().cameras.find((c) => c.channelId === channelId)
          ?? { channelId, name: 'Camera', status: 'online' as const };
        const earliest = utcTimeStrToUnix(segs[0].startTime);
        setCurrentTime(earliest);
        playbackManager.openAll([cam], earliest, dayEnd, 'main');
        playbackStore.getState().setPlaying(true);
      } catch (err) {
        console.log('[playback-camera] init error:', err instanceof Error ? err.message : err);
        if (!cancelled) setInitFailed(true);
      } finally {
        if (!cancelled) setLoadingSegments(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [channelId, host, token, sessionIdStr, selectedDate, retryCounter, getFreshSession, setCameraSegments, setCurrentTime, setLoadingSegments]);

  // Per-camera segments converted to TimeRange[] for the timeline
  const cameraSegmentsRaw = usePlaybackStore(
    (s) => s.cameraSegments[channelId ?? ''],
  );
  const segments: TimeRange[] = useMemo(() => {
    if (!cameraSegmentsRaw) return [];
    return cameraSegmentsRaw.map((seg) => ({
      start: utcTimeStrToUnix(seg.startTime),
      end: utcTimeStrToUnix(seg.endTime),
    }));
  }, [cameraSegmentsRaw]);

  // True when this camera has segments for the day but none covers the
  // current playhead. Boolean selector — re-renders only on transitions.
  const hasFootageAtPlayhead = usePlaybackStore((s) =>
    segmentCoveringTime(s.cameraSegments[channelId ?? ''], s.currentTime) != null,
  );
  const hasAnySegmentsForDay = (cameraSegmentsRaw?.length ?? 0) > 0;
  const showNoFootage = hasAnySegmentsForDay && !hasFootageAtPlayhead;

  const dayStartUnix = useMemo(
    () => dayToUnixRange(selectedDate).start,
    [selectedDate],
  );

  const dateLabel = useMemo(
    () => formatDateLabel(selectedDate),
    [selectedDate],
  );

  // ---- Transport callbacks ----
  const handleSeek = useCallback(
    (unixTime: number) => {
      setCurrentTime(unixTime);
      // Bump seek epoch so the native view flushes its display-layer queue
      // (matches the grid's handleSeek). Without this, small scrubs at high
      // speed can leave pre-scrub frames queued and the tile keeps painting
      // the previous position.
      playbackStore.getState().bumpSeekEpoch();
      const timeStr = unixToUtcTimeStr(unixTime);
      playbackManager.seekAll(timeStr);
    },
    [setCurrentTime],
  );

  // Small-delta skip: try an in-place `all_frame` seek on the open task
  // first — avoids the full close/reopen latency when the target stays in
  // the currently-streaming segment. Falls back to the standard seekAll
  // path when the jump crosses a segment boundary (the connection would
  // need to reopen against a new time window anyway).
  const doSmallSkip = useCallback(
    (deltaSec: number) => {
      const pb = playbackStore.getState();
      const target = pb.currentTime + deltaSec;
      const segs = pb.cameraSegments[channelId ?? ''];
      const sourceSeg = segmentCoveringTime(segs, pb.currentTime);
      const targetSeg = segmentCoveringTime(segs, target);
      pb.setCurrentTime(target);
      pb.bumpSeekEpoch();
      const timeStr = unixToUtcTimeStr(target);
      if (sourceSeg && targetSeg && sourceSeg === targetSeg) {
        playbackManager.trySeekInPlace(timeStr);
      } else {
        playbackManager.seekAll(timeStr);
      }
    },
    [channelId],
  );

  // Server takes a few seconds of wall clock to land a fresh IDR after a
  // seek, so playback resumes several seconds ahead of the requested target.
  // Bias the deltas to compensate.
  const handleSkipBackward = useCallback(() => {
    doSmallSkip(-14);
  }, [doSmallSkip]);

  const handleSkipForward = useCallback(() => {
    doSmallSkip(8);
  }, [doSmallSkip]);

  const handlePlayPause = useCallback(() => {
    // Scope to the visible channel so the button doesn't accidentally resume
    // the 11 background-paused siblings (the mount effect paused them so
    // they stop wasting bandwidth while single-cam is on top).
    if (!channelId) return;
    if (isPlaying) {
      playbackManager.pauseChannel(channelId);
      setPlaying(false);
    } else {
      playbackManager.resumeChannel(channelId);
      setPlaying(true);
    }
  }, [channelId, isPlaying, setPlaying]);

  const handleSpeedChange = useCallback(
    (s: 1 | 2 | 4 | 8) => {
      setSpeed(s);
      // Also drive the playback-manager — it adjusts the connection's ACK
      // pacing and triggers a restart when we cross the keyframe-only mode
      // threshold. Without this the native timebase advances at the new
      // rate but the server keeps delivering at the old one, producing
      // alternating fast/slow playback and eventual freezes.
      playbackManager.setSpeed(s);
    },
    [setSpeed],
  );

  const handleDatePress = useCallback(() => {
    setDatePickerVisible(true);
  }, []);

  const handleSelectDate = useCallback(
    async (dateStr: string) => {
      setDatePickerVisible(false);
      if (dateStr === selectedDate || !channelId) return;

      // Project the previous clock-time onto the new day so the user lands
      // at roughly the same hh:mm:ss.
      const prevTime = playbackStore.getState().currentTime;
      const projected = projectTimeOntoDay(prevTime, selectedDate, dateStr);

      // Query just this camera's segments immediately so we can snap to its
      // nearest segment edge (the projected clock-time may land in a gap for
      // this specific camera). The grid's init effect, triggered by the
      // setSelectedDate below, will re-query all 12 cameras' segments and
      // (re)open their connections — that is now the single source of
      // truth for opening connections on the new day. We do NOT call openAll
      // here anymore: two concurrent openAll calls (one from here, one from
      // grid's init) race and whichever finishes last wins, so a return to
      // grid could show 11 closed tiles if single-cam's 1-camera openAll
      // happened to land after grid's 12-camera one.
      if (!host || !token || !sessionIdStr) return;
      setLoadingSegments(true);
      try {
        const newSegments = await queryChlRecLogFresh(
          channelId,
          `${dateStr} 00:00:00`,
          `${dateStr} 23:59:59`,
        );
        setCameraSegments(channelId, newSegments);
        const target =
          pickTargetTime(newSegments, projected) ??
          (newSegments.length > 0
            ? utcTimeStrToUnix(newSegments[0].startTime)
            : projected);
        setCurrentTime(target);
      } catch (err) {
        console.log('[playback-camera] date change error:', err instanceof Error ? err.message : err);
        setCurrentTime(projected);
      }

      // Close existing playback and flush the native display layer so the
      // previous day's queued samples don't keep painting while the new
      // day's footage loads. setSelectedDate triggers the grid's init
      // effect, which opens connections for every covered channel at the
      // current playhead (which we just set to `target` above).
      playbackManager.closeAll();
      playbackStore.getState().bumpSeekEpoch();
      setSelectedDate(dateStr);
      // setLoadingSegments stays true until the grid init effect finishes
      // its 12-camera query — it owns that flag from here on.
    },
    [
      selectedDate,
      channelId,
      setSelectedDate,
      setLoadingSegments,
      host,
      token,
      sessionIdStr,
      setCameraSegments,
      setCurrentTime,
    ],
  );

  // Background refresh — re-query this channel's segments and merge in
  // place, without setting loadingSegments. Used by
  // useTimelineAutoRefresh to extend the timeline's right edge as new
  // recordings land while the user is sitting on "today". Cancel guard
  // drops writes if the date changed mid-query so we don't overwrite a
  // fresh date-switch with stale results.
  const refreshSegmentsBackground = useCallback(async () => {
    if (!channelId) return;
    const startDate = playbackStore.getState().selectedDate;
    const startTimeStr = `${startDate} 00:00:00`;
    const endTimeStr = `${startDate} 23:59:59`;

    // Fire dates query alongside segments so a day-rollover refresh
    // picks up the new "today" entry in the date picker.
    const [segmentsResult, datesResult] = await Promise.all([
      queryChlRecLogFresh(channelId, startTimeStr, endTimeStr).catch(
        (err) => {
          console.log(
            '[playback-camera] refresh failed:',
            err instanceof Error ? err.message : err,
          );
          return null;
        },
      ),
      queryDatesExistRecFresh(channelId).catch((err) => {
        console.log(
          '[playback-camera] refresh dates failed:',
          err instanceof Error ? err.message : err,
        );
        return null;
      }),
    ]);

    if (playbackStore.getState().selectedDate !== startDate) return;

    // Treat empty as "probably stale session" when we already have
    // segments cached — see the matching guard in the grid screen.
    if (segmentsResult !== null) {
      const prior =
        playbackStore.getState().cameraSegments[channelId]?.length ?? 0;
      if (!(segmentsResult.length === 0 && prior > 0)) {
        setCameraSegments(channelId, segmentsResult);
      }
    }

    // Drop the dates write if the user swiped to another camera while
    // this refresh was in-flight — dates are per-channel, and writing
    // the old camera's set into screen-local state would shadow the
    // new camera's. setCameraSegments above is fine: it's keyed by the
    // captured channelId in the store, so writing the old channel's
    // segments to its own cache is still correct.
    if (
      datesResult !== null &&
      channelIdRef.current === channelId &&
      !(datesResult.dates.length === 0 && availableDatesRef.current.size > 0)
    ) {
      // Skip the write when the date set is unchanged — see grid screen.
      const prev = availableDatesRef.current;
      const same =
        prev.size === datesResult.dates.length &&
        datesResult.dates.every((d) => prev.has(d));
      if (!same) setAvailableDates(new Set(datesResult.dates));
    }
  }, [channelId, setCameraSegments]);

  useTimelineAutoRefresh({
    refresh: refreshSegmentsBackground,
    onDayRollover: handleSelectDate,
  });

  // ---- Pinch / Pan / Tap gestures ----
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const { width: screenW, height: screenH } = useWindowDimensions();

  // Viewport size — measured from the video container via onLayout so the
  // clamp matches the actual displayed area (not the full screen).
  const viewportW = useSharedValue(screenW);
  const viewportH = useSharedValue(screenH);

  const clampTranslate = (
    tx: number,
    ty: number,
    s: number,
  ): [number, number] => {
    'worklet';
    // NVR streams are 16:9. Compute fit-inside content size, clamp against
    // that so pan never reveals background past the viewport (iOS Photos).
    const VIDEO_AR = 16 / 9;
    const vw = viewportW.value;
    const vh = viewportH.value;
    const viewportAR = vw / vh;
    const contentW = viewportAR > VIDEO_AR ? vh * VIDEO_AR : vw;
    const contentH = viewportAR > VIDEO_AR ? vh : vw / VIDEO_AR;
    const maxTx = Math.max(0, (contentW * s - vw) / 2);
    const maxTy = Math.max(0, (contentH * s - vh) / 2);
    return [
      Math.min(maxTx, Math.max(-maxTx, tx)),
      Math.min(maxTy, Math.max(-maxTy, ty)),
    ];
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, savedScale.value * e.scale),
      );
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
        scale.value = withTiming(1, { duration: 250 });
        savedScale.value = 1;
        translateX.value = withTiming(0, { duration: 250 });
        translateY.value = withTiming(0, { duration: 250 });
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        scale.value = withTiming(DOUBLE_TAP_ZOOM, { duration: 250 });
        savedScale.value = DOUBLE_TAP_ZOOM;
        translateX.value = 0;
        translateY.value = 0;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      }
    });

  // ---- Swipe between cameras (single-cam playback) ----
  // Preserves the timeline playhead across cameras: if the current
  // timestamp falls inside a segment on the target camera we open there,
  // otherwise we snap to the nearest segment edge. The generation counter
  // guards against rapid double-swipes racing with in-flight segment
  // queries; isSwitchingRef blocks re-entry while an animation is running.
  const slideX = useSharedValue(0);
  const isSwitchingRef = useRef(false);
  const swipeGenRef = useRef(0);

  const clearSwitching = useCallback(() => {
    isSwitchingRef.current = false;
  }, []);

  const applyChannelSwitch = useCallback(
    (
      nextCam: CameraInfo,
      target: number | null,
      wasPlaying: boolean,
      dayEnd: number,
      myGen: number,
    ) => {
      if (myGen !== swipeGenRef.current) return;
      // Capture the sink keyed by the current (outgoing) channelId before
      // closeAll wipes the sinks map. use-playback's `sink` is a stable
      // callback (empty deps) that always routes into `viewRef.current`,
      // so the same function reference is valid for the incoming channel —
      // we just need to re-key it under the target channelId so openOne
      // picks it up without hitting the noop-sink fallback during the
      // pre-commit window.
      const currentSink = playbackManager.getSink(channelId);
      // Tear down the old single-camera connection. Cached segments for
      // other channels in the store are left alone.
      playbackManager.closeAll();
      // Blank the native view immediately so the outgoing camera's last
      // frame doesn't show through during the slide-in. Without this, the
      // display layer keeps painting until the new stream delivers a fresh
      // keyframe. The solid-black loading overlay below takes over once
      // `hasFirstFrame` flips to false on the re-render.
      viewRef.current?.flush(0).catch(() => {});
      // Swap the URL param — same route, no remount, no stack transition.
      router.setParams({ channelId: nextCam.channelId });
      // Clear any init-failure overlay carried over from the previous camera
      // so we don't briefly show "Couldn't load recordings" on the new one.
      setInitFailed(false);

      if (target != null) {
        playbackStore.getState().setCurrentTime(target);
        playbackStore.getState().bumpSeekEpoch();
        // Pre-register the sink for the target channel so the new
        // connection gets a real sink from the start. See primeSinkFor's
        // doc on PlaybackManager for the race this closes.
        if (currentSink) {
          playbackManager.primeSinkFor(nextCam.channelId, currentSink);
        }
        // Refocus before opening so the new conn resolves to stream 0
        // directly when HQ is on — otherwise it opens at stream 1 and
        // gets restarted as soon as the channelId-effect fires
        // closeAllExcept(newChannelId).
        playbackManager.setFocusedChannel(nextCam.channelId);
        playbackManager.openAll([nextCam], target, dayEnd, 'main');
        if (!wasPlaying) playbackManager.pauseAll();
      } else {
        // Target camera has no recordings for the selected day — stop
        // playback and surface the retry/empty overlay the init-failure
        // UI already renders.
        playbackStore.getState().setPlaying(false);
        setInitFailed(true);
      }
    },
    [router],
  );

  const switchCamera = useCallback(
    async (dir: 1 | -1) => {
      if (isSwitchingRef.current) return;
      if (!channelId || cameras.length < 2) return;
      const idx = cameras.findIndex((c) => c.channelId === channelId);
      if (idx < 0) return;
      const nextCam = cameras[(idx + dir + cameras.length) % cameras.length];
      if (nextCam.channelId === channelId) return;

      const myGen = ++swipeGenRef.current;
      isSwitchingRef.current = true;

      const pb = playbackStore.getState();
      const preferredTime = pb.currentTime;
      const wasPlaying = pb.isPlaying;
      const dateStr = pb.selectedDate;
      const { end: dayEnd } = dayToUnixRange(dateStr);

      // Load segments for the target camera if not cached.
      let segs = pb.cameraSegments[nextCam.channelId];
      if (!segs) {
        const startTimeStr = `${dateStr} 00:00:00`;
        const endTimeStr = `${dateStr} 23:59:59`;
        try {
          segs = await queryChlRecLogFresh(
            nextCam.channelId,
            startTimeStr,
            endTimeStr,
          );
          if (myGen !== swipeGenRef.current) return;
          playbackStore.getState().setCameraSegments(nextCam.channelId, segs);
        } catch (err) {
          console.log(
            '[playback-camera] swipe: segment query failed:',
            err instanceof Error ? err.message : err,
          );
          if (myGen !== swipeGenRef.current) return;
          segs = [];
        }
      }

      if (myGen !== swipeGenRef.current) return;

      const target = pickTargetTime(segs ?? [], preferredTime);

      // Now run the slide animation. At the midpoint we swap channelId and
      // open the new connection in applyChannelSwitch.
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
          runOnJS(applyChannelSwitch)(nextCam, target, wasPlaying, dayEnd, myGen);
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

  // Stable reference for the down-swipe handler — runOnJS loses `this`
  // binding if passed `router.back` directly, so we wrap.
  const goBackToGrid = useCallback(() => {
    router.back();
  }, [router]);

  // Jump to the Live tab's single-camera view for this channel. Mirrors
  // openRecordings in the live screen — see that file for why we use
  // tabNav.navigate + `initial: false` instead of router.push.
  const openLive = useCallback(() => {
    if (!channelId) return;
    tabNav?.navigate('(live)', {
      screen: 'camera/[channelId]',
      params: { channelId },
      initial: false,
    });
  }, [channelId, tabNav]);

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
  // doesn't fight pinch or zoomed-image panning. Bails on end when
  // zoomed so the user can still vertical-pan inside a zoom.
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

  const composed = Gesture.Race(
    Gesture.Simultaneous(pinch, pan, swipePan, downSwipe),
    doubleTap,
  );

  // Reset zoom/pan when the channel changes via swipe (screen stays mounted,
  // so zoom state would otherwise leak across cameras).
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

  const handleRetry = useCallback(async () => {
    // Reset init state and do a full teardown + fresh login via
    // hardRetry. Prior versions called refreshSessionNow (extra-session
    // login) to unstick a stale-token silent-empty query; hardRetry is
    // a strict superset — it also tears down any half-open live/playback
    // WebSockets and stale extras that can keep the client wedged even
    // after a fresh session exists. Bumping retryCounter re-runs the
    // init effect to requery segments with the freshly logged-in state.
    initializedRef.current = false;
    setInitFailed(false);
    await nvrClient.hardRetry();
    setRetryCounter((n) => n + 1);
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <Animated.View style={[styles.slideWrap, slideStyle]}>
      {/* Video area */}
      <View style={styles.videoArea}>
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
              style={styles.video}
            />
          </Animated.View>
        </GestureDetector>

        {rateOverlay}

        {/* Loading spinner overlay — shown until the first frame reaches
            the native view OR an init/open failure triggers the retry UI.
            Suppressed when we're intentionally in a gap — the manager
            keeps the connection closed there, so no frame is coming. */}
        {!hasFirstFrame && !initFailed && !channelFailed && !showNoFootage && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#FFFFFF" />
          </View>
        )}

        {/* No footage overlay — current playhead sits in a gap for this
            camera (e.g., before its first recording of the day). */}
        {showNoFootage && (
          <View style={styles.noFootageOverlay}>
            <ThemedText style={styles.noFootageText}>No footage</ThemedText>
          </View>
        )}

        {/* Retry overlay — shown when the deep-link init failed or
            returned empty (stale token, network error, or legitimately
            no recordings), or when the playback connection's retry
            chain exhausted. Tapping Retry runs hardRetry (matches
            force-quit semantics) and re-triggers the init flow. */}
        {(initFailed || channelFailed) && (
          <View style={styles.disconnectOverlay}>
            <ThemedText style={styles.disconnectText}>
              {initFailed
                ? "Couldn't load recordings"
                : "Couldn't open playback"}
            </ThemedText>
            <Pressable style={styles.retryButton} onPress={handleRetry}>
              <ThemedText style={styles.retryText}>Retry</ThemedText>
            </Pressable>
          </View>
        )}
      </View>

      {/* Top chrome: camera name + back button (overlay, matches live view) */}
      <View style={styles.chrome} pointerEvents="box-none">
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
            onPress={openLive}
            style={styles.liveButton}
            hitSlop={{ top: 16, bottom: 16, right: 16, left: 6 }}
            accessibilityLabel="View live for this camera"
          >
            <Ionicons name="videocam-outline" size={24} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>

      {/* Controls area */}
      <View style={styles.controlsArea}>
        {/* Transport controls — disabled until segments are loaded and the
            view has its first frame. Date picker stays tappable so the
            user can try a different day if load stalls. */}
        <TransportControls
          isPlaying={isPlaying}
          speed={speed}
          onPlayPause={handlePlayPause}
          onSpeedChange={handleSpeedChange}
          onSkipBackward={handleSkipBackward}
          onSkipForward={handleSkipForward}
          dateLabel={dateLabel}
          onDatePress={handleDatePress}
          disabled={loadingSegments || !hasFirstFrame}
        />

        {/* Timeline — only gated on segments. Seek-load in-progress (no
            first frame yet after a scrub) must NOT disable the timeline,
            so the user can keep dragging rapidly through the day. */}
        <Timeline
          segments={segments}
          dayStartUnix={dayStartUnix}
          currentTime={currentTime}
          isPlaying={isPlaying}
          onSeek={handleSeek}
          disabled={loadingSegments}
          bottomInset={Math.max(insets.bottom, 12)}
        />
      </View>
      </Animated.View>

      {/* Date Picker — outside the slide wrapper so the modal doesn't slide */}
      <DatePickerModal
        visible={datePickerVisible}
        onClose={() => setDatePickerVisible(false)}
        onSelectDate={handleSelectDate}
        selectedDate={selectedDate}
        availableDates={availableDates}
      />
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
  videoArea: {
    flex: 1,
    backgroundColor: '#000000',
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
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  noFootageOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000000',
  },
  noFootageText: {
    fontSize: 16,
    fontWeight: '500',
    color: Surface.secondaryText,
  },
  controlsArea: {
    backgroundColor: '#000000',
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
  liveButton: {
    width: 44,
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
  disconnectOverlay: {
    ...StyleSheet.absoluteFillObject,
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
