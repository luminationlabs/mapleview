import { AppState } from "react-native";
import { useRef, useEffect } from "react";
import { nvrClient } from "../nvr/client";
import { playbackManager } from "../nvr/playback-manager";
import { lifecycleStore } from "../store/lifecycle-store";
import { playbackStore } from "../store/playback-store";

const BACKGROUND_CLOSE_DELAY = 5000;
const COLD_RESET_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Hook that manages app lifecycle transitions for the NVR client and
 * playback manager.
 *
 * - Backgrounded > 5 seconds: close all streaming WebSockets on both
 *   managers. iOS kills WSes silently after a while anyway; without
 *   explicit close the managers think streams are still alive and
 *   don't reconnect on foreground.
 * - Foregrounded: re-authenticate nvrClient if needed, reopen live
 *   and playback streams. If a teardown actually fired, bumps
 *   lifecycleStore.foregroundEpoch so video-view hooks can reset
 *   first-frame state and flush the native display layer.
 * - Backgrounded > 5 minutes: also fires onColdReset on foreground so
 *   the caller can wipe the navigation stack — at that point the user
 *   has clearly moved on and shouldn't be returned to the exact screen
 *   they left.
 */
export function useAppLifecycle(opts?: { onColdReset?: () => void }) {
  const onColdResetRef = useRef(opts?.onColdReset);
  onColdResetRef.current = opts?.onColdReset;
  const backgroundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Tracks whether the BACKGROUND_CLOSE_DELAY timer actually fired. Used
  // to decide whether to bump the foreground epoch — quick bounces leave
  // streams intact and the native display layers still have valid frames,
  // so we don't want to flash the spinner over them.
  const closeRanRef = useRef(false);
  // Captures playbackStore.isPlaying at background time so we can restore
  // it on foreground. The playback-layout interval advances currentTime
  // via Date.now() deltas while isPlaying is true; if we don't pause it
  // on background, the first tick after resume (or an iOS tail tick during
  // an inactive state) jumps the playhead by the full background duration,
  // and handleForeground then reopens that far ahead of where the user
  // left off. Live streams don't use this interval, so they're unaffected.
  const wasPlayingRef = useRef(false);
  // Wall-clock timestamp of the first background/inactive transition since
  // the last foreground. Compared against COLD_RESET_THRESHOLD_MS on resume
  // to decide whether to wipe the navigation stack.
  const backgroundedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const handleAppStateChange = (nextAppState: string) => {
      if (nextAppState === "background" || nextAppState === "inactive") {
        // Stamp the first transition out of foreground. iOS fires this
        // branch twice (inactive → background); only the first counts
        // for elapsed-time purposes.
        if (backgroundedAtRef.current == null) {
          backgroundedAtRef.current = Date.now();
        }

        // Freeze the playback playhead immediately — before the 5-second
        // close timer, so no tick of the currentTime-advance interval
        // can accumulate while the app is leaving the foreground. Also
        // captures the user's intent so we only resume if they were
        // actively playing (not if they had manually paused).
        //
        // Only capture when isPlaying is actually true. iOS fires this
        // branch twice on backgrounding (inactive → background); the
        // first fire sets isPlaying=false, and if we blindly re-captured
        // on the second fire we'd overwrite wasPlayingRef with false and
        // then fail to restore on foreground.
        const pb = playbackStore.getState();
        if (pb.isPlaying) {
          wasPlayingRef.current = true;
          pb.setPlaying(false);
        }

        // Clear any existing timer to avoid leaks from inactive -> background transitions
        if (backgroundTimerRef.current) {
          clearTimeout(backgroundTimerRef.current);
        }
        // Start 5-second timer to close streams
        backgroundTimerRef.current = setTimeout(() => {
          backgroundTimerRef.current = null;
          nvrClient.closeAllStreams();
          playbackManager.handleBackground();
          closeRanRef.current = true;
        }, BACKGROUND_CLOSE_DELAY);
      } else if (nextAppState === "active") {
        // Cancel the timer if we came back quickly
        if (backgroundTimerRef.current) {
          clearTimeout(backgroundTimerRef.current);
          backgroundTimerRef.current = null;
        }
        if (closeRanRef.current) {
          closeRanRef.current = false;
          lifecycleStore.getState().bumpForegroundEpoch();
        }

        const backgroundedAt = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (
          backgroundedAt != null &&
          Date.now() - backgroundedAt > COLD_RESET_THRESHOLD_MS
        ) {
          onColdResetRef.current?.();
        }

        // Fire playback-manager synchronously first so its spinner state
        // shows immediately. nvrClient runs in parallel — both managers
        // have independent session pools so they don't need to serialize.
        // handleForeground captures the frozen currentTime as the reopen
        // target, so it must run BEFORE we restore isPlaying below (which
        // would re-start the interval that advances currentTime).
        playbackManager.handleForeground();
        nvrClient.handleForeground();

        // Restore the pre-background play state. Leaves isPlaying alone
        // when the user had manually paused — that's a no-op restore.
        if (wasPlayingRef.current) {
          wasPlayingRef.current = false;
          playbackStore.getState().setPlaying(true);
        }
      }
    };

    const sub = AppState.addEventListener("change", handleAppStateChange);
    return () => sub.remove();
  }, []);
}
