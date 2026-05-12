import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraGrid } from '@/src/components/camera-grid';
import { DatePickerModal } from '@/src/components/date-picker-modal';
import { DisconnectBanner } from '@/src/components/disconnect-banner';
import { LayoutPicker } from '@/src/components/layout-picker';
import { Timeline } from '@/src/components/timeline';
import { TransportControls } from '@/src/components/transport-controls';
import { usePlaybackStore, playbackStore } from '@/src/store/playback-store';
import { useCameraStore } from '@/src/store/camera-store';
import { useSessionStore } from '@/src/store/session-store';
import { playbackManager } from '@/src/nvr/playback-manager';
import { nvrClient } from '@/src/nvr/client';
import { queryDatesExistRec, queryChlRecLog } from '@/src/nvr/xml';
import { queryChlRecLogFresh, queryDatesExistRecFresh } from '@/src/nvr/query-helpers';
import { dayToUnixRange, projectTimeOntoDay, snapToNearestRange, unixToUtcTimeStr, utcTimeStrToUnix } from '@/src/utils/time';
import { formatDateLabel } from '@/src/utils/date-label';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useWindowDimensions } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ThemedText } from '@/src/components/ui/themed-text';
import { Surface } from '@/src/constants/theme';

const TIMELINE_HEIGHT = 80;
const TRANSPORT_HEIGHT = 44;

export default function PlaybackScreen() {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  const compositeSegments = usePlaybackStore((s) => s.compositeSegments);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const speed = usePlaybackStore((s) => s.speed);
  const selectedDate = usePlaybackStore((s) => s.selectedDate);
  const setCurrentTime = usePlaybackStore((s) => s.setCurrentTime);
  const setPlaying = usePlaybackStore((s) => s.setPlaying);
  const setSpeed = usePlaybackStore((s) => s.setSpeed);
  const setSelectedDate = usePlaybackStore((s) => s.setSelectedDate);
  const setCameraSegments = usePlaybackStore((s) => s.setCameraSegments);
  const clearSegments = usePlaybackStore((s) => s.clearSegments);
  const computeCompositeSegments = usePlaybackStore((s) => s.computeCompositeSegments);
  const setLoadingSegments = usePlaybackStore((s) => s.setLoadingSegments);
  const setHasQueriedSegments = usePlaybackStore((s) => s.setHasQueriedSegments);

  const loadingSegments = usePlaybackStore((s) => s.loadingSegments);
  const hasQueriedSegments = usePlaybackStore((s) => s.hasQueriedSegments);

  const cameras = useCameraStore((s) => s.cameras);
  const connected = useSessionStore((s) => s.connected);

  // Tracks which date we successfully initialized for. Reset naturally
  // when `selectedDate` drifts — including the case where single-cam's
  // handleSelectDate changed the date behind our back, after which the
  // grid's segments for the other 11 cameras would otherwise stay on the
  // previous day. Boolean flag was insufficient for that cross-screen
  // reset; the date itself is the authoritative "did we init for this?".
  const initializedForDate = useRef<string | null>(null);
  // Bumped when an init attempt fails so the init effect re-runs after a
  // delay. Without this, if every per-camera query throws (e.g. the session
  // was stale because the live tab hadn't finished logging in yet), we'd
  // have no signal to retry and would be stuck showing an empty state.
  const [initRetry, setInitRetry] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Playback-manager's current-time provider and the playhead-advance
  // interval both live in (playback)/_layout.tsx so they work from either
  // the grid or the single-camera screen.

  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [availableDates, setAvailableDates] = useState<Set<string>>(new Set());
  // Timeline effect reads this to decide whether to piggyback a refetch
  // after a successful segment load (see below). Keeping it in a ref
  // avoids adding availableDates to the timeline effect's deps, which
  // would re-fire the whole init path every time the picker populates.
  const availableDatesRef = useRef(availableDates);
  availableDatesRef.current = availableDates;

  // Query dates for the first camera (covers most use cases).
  // queryDatesExistRecFresh retries once with a fresher token if the
  // first call returned empty and another login landed in the meantime
  // — but if no new login lands, the silent-empty is passed through.
  // The timeline effect calls this again on success to recover in that
  // case, so we return the raw result here rather than writing state.
  const fetchAvailableDates = useCallback(async (): Promise<string[] | null> => {
    if (cameras.length === 0) return null;
    try {
      const info = await queryDatesExistRecFresh(cameras[0].channelId);
      return info.dates;
    } catch (err) {
      console.log('[playback] failed to fetch available dates:', err instanceof Error ? err.message : err);
      return null;
    }
  }, [cameras]);

  // Fetch available recording dates when we have a session and cameras
  useEffect(() => {
    const s = playbackManager.latestSession ?? nvrClient.latestSession;
    if (!s || cameras.length === 0) return;
    let cancelled = false;

    (async () => {
      const dates = await fetchAvailableDates();
      if (!cancelled && dates !== null) {
        setAvailableDates(new Set(dates));
      }
    })();

    return () => { cancelled = true; };
  }, [cameras, connected, fetchAvailableDates]);

  // ---- Item 1: Initialize playback on first mount when connected ----
  useEffect(() => {
    if (initializedForDate.current === selectedDate) return;
    if (cameras.length === 0) return;
    // Check that some session is available up-front; the actual session
    // used for queries is re-read after awaitPendingLogins below.
    if (!(playbackManager.latestSession ?? nvrClient.latestSession)) {
      // handleSelectDate sets loadingSegments=true and hands off to this
      // effect — if we bail on no-session, we'd otherwise leave the
      // spinner up forever.
      setLoadingSegments(false);
      return;
    }

    // Post-await writes into Zustand (setCameraSegments, setCurrentTime,
    // openAll, etc.) can land after a rapid date switch re-fires this
    // effect. Without a cancel guard the stale run's writes overwrite the
    // fresh run's, producing a timeline that mixes two days' segments or
    // leaves the playhead on the old day.
    let cancelled = false;

    (async () => {
      setLoadingSegments(true);

      // PlaybackManager uses nvrClient's session pool — credentials
      // already live there (set during the initial login). No manager-
      // level credential plumbing needed here any more.
      playbackManager.setSpeed(speed);

      // Wait for any in-flight extra-session logins to settle before
      // querying — the NVR invalidates earlier HTTP tokens as new logins
      // complete, and a query that races a pending login gets silent
      // empty results. After awaiting, pull the session again so we use
      // the freshest token rather than the snapshot captured pre-await.
      await nvrClient.awaitPendingLogins();
      if (cancelled) return;
      const freshSession = playbackManager.latestSession ?? nvrClient.latestSession;
      if (!freshSession) {
        setLoadingSegments(false);
        return;
      }
      // queryChlRecLogFresh / queryDatesExistRecFresh read latestSession
      // themselves — the freshSession check above is just a gate against
      // running queries before the client has logged in at all.

      const { start: dayStart, end: dayEnd } = dayToUnixRange(selectedDate);
      const startTimeStr = `${selectedDate} 00:00:00`;
      const endTimeStr = `${selectedDate} 23:59:59`;
      const visibleChannelIds: string[] = [];
      let successCount = 0;
      let retryScheduled = false;

      try {
        await Promise.all(
          cameras.map(async (cam) => {
            try {
              // queryChlRecLogFresh does a per-query token-change retry:
              // if the first attempt comes back empty and nvrClient has
              // since picked up a newer session (e.g. live pool fired an
              // extra-login mid-batch), it retries with the fresh token.
              // Catches the common silent-empty-from-invalidated-token case
              // without needing a full batch-level retry cycle.
              const segments = await queryChlRecLogFresh(
                cam.channelId,
                startTimeStr,
                endTimeStr,
              );
              if (cancelled) return;
              setCameraSegments(cam.channelId, segments);
              successCount++;
              if (segments.length > 0) {
                visibleChannelIds.push(cam.channelId);
              }
            } catch (err) {
              console.log(`[playback] init: failed to query segments for ${cam.channelId.slice(1,9)}:`, err instanceof Error ? err.message : err);
            }
          }),
        );
        if (cancelled) return;

        // Failure modes that warrant a retry:
        //  - all queries threw (HTTP error, network, bad session)
        //  - all queries succeeded but every segment list is empty
        //    (NVR silently returns empty recList when the HTTP token was
        //    invalidated mid-batch by another login completing). Capped
        //    at a small number of attempts so legitimate empty-date
        //    responses don't retry forever.
        const allEmpty =
          cameras.length > 0 &&
          successCount === cameras.length &&
          visibleChannelIds.length === 0;
        const allThrew = cameras.length > 0 && successCount === 0;
        if ((allThrew || allEmpty) && initRetry < 2) {
          console.log(
            `[playback] init: ${allThrew ? 'all threw' : 'all empty'}, retry ${initRetry + 1}/2`,
          );
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(async () => {
            retryTimerRef.current = null;
            // If every camera came back empty, the token is almost
            // certainly stale and no other code path has fired a login
            // in the meantime (the per-query retry above would have
            // already recovered if a login landed). Force one ourselves
            // so the next effect run has a valid token to work with.
            if (allEmpty) {
              await nvrClient.refreshSessionNow();
            }
            setInitRetry((n) => n + 1);
          }, 1500);
          retryScheduled = true;
          return;
        }

        computeCompositeSegments(cameras.map((c) => c.channelId));
        setHasQueriedSegments(true);

        // Piggyback recovery for the date picker: the dates effect fires
        // in parallel with this one and has no batch-level retry, so a
        // silent-empty-on-invalidated-token leaves availableDates stuck
        // at empty even after we've recovered a good session here. If
        // we just loaded real segments but the picker is still empty,
        // refetch — we know the current session works.
        if (visibleChannelIds.length > 0 && availableDatesRef.current.size === 0) {
          void (async () => {
            const dates = await fetchAvailableDates();
            if (!cancelled && dates !== null && dates.length > 0) {
              setAvailableDates(new Set(dates));
            }
          })();
        }

        const camerasWithRecordings = cameras.filter((c) =>
          visibleChannelIds.includes(c.channelId),
        );
        if (camerasWithRecordings.length > 0) {
          // Pick the playhead time. If the store already has a currentTime
          // that falls within the new day (e.g., a day-switch projected the
          // previous clock-time onto this day — see handleSelectDate), use
          // that to preserve the user's context. Otherwise fall back to
          // "~10 minutes ago" so a cold launch lands on recent footage
          // rather than midnight. Clamp to the actual segment range so
          // past-day views still start near end-of-day rather than
          // outside any recording.
          const allSegments = playbackStore.getState().cameraSegments;
          let latestSegEnd = dayStart;
          for (const segs of Object.values(allSegments)) {
            for (const seg of segs) {
              const t = utcTimeStrToUnix(seg.endTime);
              if (t > latestSegEnd) latestSegEnd = t;
            }
          }
          const existingTime = playbackStore.getState().currentTime;
          const existingOnDay =
            existingTime >= dayStart && existingTime <= dayEnd;
          const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
          const preferred = existingOnDay ? existingTime : tenMinutesAgo;
          // If the preferred clock-time lands in a cross-camera gap on
          // the new day (no camera has footage at that moment), snap to
          // the nearest segment edge instead of leaving the user on an
          // empty timeline. Uses compositeSegments (union of all cameras'
          // segments) populated by computeCompositeSegments above.
          const composite = playbackStore.getState().compositeSegments;
          const snapped = snapToNearestRange(composite, preferred) ?? preferred;
          const seekTo = Math.max(
            dayStart,
            Math.min(latestSegEnd, snapped),
          );
          setCurrentTime(seekTo);
          playbackManager.openAll(camerasWithRecordings, seekTo, dayEnd, "main");
          // Cameras play as soon as connections open, so reflect that in the UI.
          setPlaying(true);
        }

        // Only mark as initialized after successful completion
        initializedForDate.current = selectedDate;
      } catch (err) {
        console.log('[playback] init error:', err instanceof Error ? err.message : err);
        // Do NOT set initializedForDate so the effect retries on next render
      } finally {
        // Keep the spinner up when we've queued a retry — otherwise the
        // empty-state would flash for 1.5s between attempts. Also skip
        // when cancelled so we don't prematurely clear a successor run's
        // spinner.
        if (!retryScheduled && !cancelled) setLoadingSegments(false);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [connected, cameras, selectedDate, initRetry, setCameraSegments, computeCompositeSegments, setCurrentTime, setLoadingSegments, setHasQueriedSegments, fetchAvailableDates]);

  // Tab-level close/reopen is handled in (playback)/_layout.tsx so that
  // drilling into the single-camera view doesn't tear down streams.

  const dayStartUnix = useMemo(
    () => dayToUnixRange(selectedDate).start,
    [selectedDate],
  );

  const handleSeek = useCallback(
    (unixTime: number) => {
      setCurrentTime(unixTime);
      // Bump the seek epoch so every mounted NvrVideoView flushes its
      // display-layer queue. Without this, small scrubs at high speed can
      // leave pre-scrub frames queued in AVSampleBufferDisplayLayer, and
      // the "stuck" tiles just keep painting their last-queued sample.
      playbackStore.getState().bumpSeekEpoch();
      const timeStr = unixToUtcTimeStr(unixTime);
      console.log(`[playback] handleSeek: seeking to ${timeStr} (unix=${unixTime})`);
      playbackManager.seekAll(timeStr);
      // Restarted connections always begin playing — re-apply pause if the
      // user had paused so the UI state stays in sync with the actual streams.
      if (!playbackStore.getState().isPlaying) {
        playbackManager.pauseAll();
      }
    },
    [setCurrentTime],
  );

  // Small-delta skip: try an in-place `all_frame` seek first when both source
  // and target fall within the same composite-segment range — trySeekInPlace
  // handles per-channel coverage and falls back to restart per connection.
  // Cross-gap jumps use seekAll since they'd need to reopen anyway.
  const doSmallSkip = useCallback(
    (deltaSec: number) => {
      const pb = playbackStore.getState();
      const target = pb.currentTime + deltaSec;
      const sourceRange = pb.compositeSegments.find(
        (r) => pb.currentTime >= r.start && pb.currentTime <= r.end,
      );
      const targetRange = pb.compositeSegments.find(
        (r) => target >= r.start && target <= r.end,
      );
      pb.setCurrentTime(target);
      pb.bumpSeekEpoch();
      const timeStr = unixToUtcTimeStr(target);
      if (sourceRange && targetRange && sourceRange === targetRange) {
        playbackManager.trySeekInPlace(timeStr);
      } else {
        playbackManager.seekAll(timeStr);
      }
      // Match handleSeek: restarted connections always begin playing, so
      // re-apply pause if the user had paused before the skip.
      if (!playbackStore.getState().isPlaying) {
        playbackManager.pauseAll();
      }
    },
    [],
  );

  // Server takes a few seconds of wall clock to land a fresh IDR after a
  // seek, so playback resumes several seconds ahead of the requested target.
  // Bias the deltas to compensate (matches single-cam).
  const handleSkipBackward = useCallback(() => {
    doSmallSkip(-14);
  }, [doSmallSkip]);

  const handleSkipForward = useCallback(() => {
    doSmallSkip(8);
  }, [doSmallSkip]);

  const handleDragStart = useCallback(() => {
    // Optionally pause during scrub
  }, []);

  const handleDragEnd = useCallback(() => {
    // Resume after scrub if needed
  }, []);

  const dateLabel = useMemo(() => formatDateLabel(selectedDate), [selectedDate]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      playbackManager.pauseAll();
      setPlaying(false);
    } else {
      playbackManager.resumeAll();
      setPlaying(true);
    }
  }, [isPlaying, setPlaying]);

  const handleSpeedChange = useCallback(
    (s: 1 | 2 | 4 | 8) => {
      setSpeed(s);
      playbackManager.setSpeed(s);
    },
    [setSpeed],
  );

  const handleDatePress = useCallback(() => {
    setDatePickerVisible(true);
  }, []);

  const handleSelectDate = useCallback(
    (dateStr: string) => {
      setDatePickerVisible(false);
      if (dateStr === selectedDate) return;

      // Cancel any retry queued from a prior init so it can't fire
      // mid-switch and race the new date's queries.
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      // Project the previous clock-time onto the new day so the playhead
      // lands at the same hh:mm:ss on the new date (e.g., 14:32 on day N
      // → 14:32 on day N-1) rather than defaulting to end-of-recordings
      // via the "1-hour-ago" fallback (which for past days clamps to
      // latestSegEnd and makes the timeline appear to jump to midnight).
      // The init effect reads currentTime and uses it when it falls on
      // the new day — see the preferred/seekTo computation above.
      const prevTime = playbackStore.getState().currentTime;
      setCurrentTime(projectTimeOntoDay(prevTime, selectedDate, dateStr));

      // Tear down current playback, then hand off to the init effect by
      // resetting its guard. Keeping day-change and first-mount on the
      // same code path means stale-token recovery (refreshSessionNow +
      // retry on all-empty) applies uniformly — without this, switching
      // days after the HTTP token got invalidated by a newer login would
      // silently show "No recordings" with no retry.
      playbackManager.closeAll();
      // Flush the native display layer so the previous day's queued
      // samples don't keep painting while the new day's footage loads.
      playbackStore.getState().bumpSeekEpoch();
      clearSegments();
      setLoadingSegments(true);
      setInitRetry(0);
      setSelectedDate(dateStr);
      // initializedForDate naturally invalidates because selectedDate is
      // changing — the init effect re-fires and sees date mismatch.
    },
    [
      selectedDate,
      setSelectedDate,
      clearSegments,
      setLoadingSegments,
      setCurrentTime,
    ],
  );

  let tabBarHeight: number;
  try {
    tabBarHeight = useBottomTabBarHeight();
  } catch {
    tabBarHeight = 49 + insets.bottom;
  }

  const topBarHeight = 44;
  const statusBarHeight = 16;
  const availableHeight =
    windowHeight - insets.top - topBarHeight - statusBarHeight - tabBarHeight - TRANSPORT_HEIGHT - TIMELINE_HEIGHT;

  // Determine if there are any recordings for the selected date
  const hasRecordings = compositeSegments.length > 0;
  // Gate playback controls until the initial segment query resolves.
  // While loading, play/pause/skip/speed/scrub are meaningless (no
  // connections are open yet) and scrubbing into nothing would leave the
  // store's currentTime in a confusing state when the grid finally mounts.
  // Date picker stays active via the `disabled` prop — the user can still
  // switch days if the query is slow.
  const controlsDisabled = loadingSegments || !hasQueriedSegments || !hasRecordings;

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeTop}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <LayoutPicker />
          <View />
        </View>
      </SafeAreaView>

      {/* Disconnect banner (reused from live tab) */}
      <DisconnectBanner />

      {/* Grid area */}
      <View style={styles.content}>
        {!connected && !loadingSegments ? (
          <View style={styles.emptyState}>
            <ThemedText style={styles.emptyStateText}>Not connected</ThemedText>
          </View>
        ) : loadingSegments ? (
          <View style={styles.emptyState}>
            <ActivityIndicator size="large" color="#FFFFFF" />
            <ThemedText style={styles.emptyStateText}>Loading recordings...</ThemedText>
          </View>
        ) : !hasRecordings && hasQueriedSegments ? (
          <View style={styles.emptyState}>
            <ThemedText style={styles.emptyStateText}>
              No recordings available for {formatDateLabel(selectedDate)}
            </ThemedText>
          </View>
        ) : (
          <CameraGrid
            availableHeight={availableHeight}
            mode="playback"
            emptyText="No recordings available"
          />
        )}
      </View>

      {/* Transport controls */}
      <TransportControls
        isPlaying={isPlaying}
        speed={speed}
        onPlayPause={handlePlayPause}
        onSpeedChange={handleSpeedChange}
        onSkipBackward={handleSkipBackward}
        onSkipForward={handleSkipForward}
        dateLabel={dateLabel}
        onDatePress={handleDatePress}
        disabled={controlsDisabled}
      />

      {/* Timeline */}
      <Timeline
        segments={compositeSegments}
        dayStartUnix={dayStartUnix}
        currentTime={currentTime}
        isPlaying={isPlaying}
        onSeek={handleSeek}
        disabled={controlsDisabled}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      />

      {/* Date Picker */}
      <DatePickerModal
        visible={datePickerVisible}
        onClose={() => setDatePickerVisible(false)}
        onSelectDate={handleSelectDate}
        selectedDate={selectedDate}
        availableDates={availableDates}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  safeTop: {
    backgroundColor: '#000000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    height: 44,
  },
  content: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
    gap: 12,
  },
  emptyStateText: {
    color: Surface.secondaryText,
    fontSize: 15,
  },
});
