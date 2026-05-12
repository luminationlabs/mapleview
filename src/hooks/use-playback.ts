import { useCallback, useEffect, useRef, useState } from "react";
import { playbackManager } from "../nvr/playback-manager";
import { playbackStore, usePlaybackStore } from "../store/playback-store";
import { useLifecycleStore } from "../store/lifecycle-store";
import type { StreamMode } from "../nvr/types";
import type { NvrVideoViewRef } from "../../modules/nvr-video-view";

/**
 * Attach a playback stream to an NvrVideoView ref. Returns a ref to pass
 * to <NvrVideoView>; the sink is registered with PlaybackManager on
 * mount and unregistered on cleanup. Expects PlaybackManager.openAll to
 * have been called. If `mode` differs from the existing connection's
 * stream mode, the connection is swapped (grid "sub" ↔ single "main").
 */
export function usePlayback(
  channelId: string,
  mode?: StreamMode,
  /** Optional observer for every frame reaching the native view. Kept as
   *  a ref so callers can change the closure without churning the sink
   *  (and thus the PlaybackManager attachment). */
  onFrame?: (isKeyFrame: boolean, pts: number, bytes: number) => void,
) {
  const viewRef = useRef<NvrVideoViewRef>(null);
  // Native view registers its tag lazily — a setSpeed from an on-mount
  // effect may race ahead and reject with "Unable to find view". Apply
  // current speed on the first successful feed() instead.
  const speedAppliedRef = useRef(false);
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const seenFrameRef = useRef(false);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  const sink = useCallback(
    (nal: Uint8Array, isKeyFrame: boolean, pts: number) => {
      // Pass through directly — copying showed up as the hot-path
      // bottleneck for H.265 IDRs. Only signal "first frame" when the
      // native view is actually ready — upgradeMode keys off that
      // signal to send a fresh IDR.
      const view = viewRef.current;
      if (!view) return;
      view.feed(nal, isKeyFrame, pts);
      onFrameRef.current?.(isKeyFrame, pts, nal.byteLength);
      if (!speedAppliedRef.current) {
        speedAppliedRef.current = true;
        const st = playbackStore.getState();
        const rate = st.isPlaying ? st.speed : 0;
        view.setSpeed(rate).catch(() => {});
      }
      if (!seenFrameRef.current) {
        seenFrameRef.current = true;
        setHasFirstFrame(true);
      }
    },
    [],
  );

  useEffect(() => {
    if (!channelId) return;

    speedAppliedRef.current = false;
    seenFrameRef.current = false;
    setHasFirstFrame(false);
    playbackManager.attach(channelId, sink, mode);

    // Manager fires this before any restart that would disturb the
    // CMTimebase (upgradeMode / detach-restore). Flushing resets
    // formatDescription + needsTimebaseAnchor so the incoming IDR
    // re-anchors cleanly instead of triggering a DisplayImmediately burst.
    playbackManager.setResyncHandler(sink, () => {
      // Resync continues from current playhead; no gate (pass 0).
      viewRef.current?.flush(0).catch(() => {});
    });

    return () => {
      playbackManager.setResyncHandler(sink, null);
      // Pass our specific sink so detach only pops if ours is still
      // active. When single-cam unmounts back to a still-mounted grid,
      // the grid's sink must not be cleared.
      playbackManager.detach(channelId, sink);
    };
  }, [channelId, sink, mode]);

  // Seek restarts the stream — reset first-frame so the spinner shows
  // instead of the stale frame.
  const seekEpochForReset = usePlaybackStore((s) => s.seekEpoch);
  useEffect(() => {
    if (seekEpochForReset === 0) return;
    seenFrameRef.current = false;
    setHasFirstFrame(false);
  }, [seekEpochForReset]);

  // On foreground after a background teardown, the manager reopens the
  // connection but the native view still shows the last-rendered frame.
  // Reset state and flush so the spinner sits over solid black.
  const foregroundEpoch = useLifecycleStore((s) => s.foregroundEpoch);
  useEffect(() => {
    if (foregroundEpoch === 0) return;
    speedAppliedRef.current = false;
    seenFrameRef.current = false;
    setHasFirstFrame(false);
    viewRef.current?.flush(0).catch(() => {});
  }, [foregroundEpoch]);

  // Mode upgrade (sub → main on single-cam entry) once the view is
  // mounted and rendering. hasFirstFrame guarantees viewRef is non-null,
  // so the fresh IDR from the new main connection won't be lost.
  const modeUpgradeRef = useRef(false);
  useEffect(() => {
    if (!hasFirstFrame || !channelId || !mode) return;
    if (modeUpgradeRef.current) return;
    modeUpgradeRef.current = true;
    playbackManager.upgradeMode(channelId, mode);
  }, [hasFirstFrame, channelId, mode]);

  useEffect(() => {
    if (!hasFirstFrame) modeUpgradeRef.current = false;
  }, [hasFirstFrame]);

  // Propagate effective rate (speed × isPlaying) to the native timebase.
  // isPlaying=false sets rate 0 — without pausing the timebase, queued
  // samples keep draining while the server is paused.
  const speed = usePlaybackStore((s) => s.speed);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  useEffect(() => {
    const rate = isPlaying ? speed : 0;
    viewRef.current?.setSpeed(rate).catch(() => {});
  }, [speed, isPlaying]);

  // Flush on every scrub. Subscribing to the vanilla store (instead of a
  // useEffect on seekEpoch) fires synchronously inside the scrub's set() —
  // before React re-render and effects. Saves a few ms of dispatch latency,
  // which matters because samples queued at scrub time keep rendering
  // until flush actually runs on the main queue.
  useEffect(() => {
    let lastSeenEpoch = playbackStore.getState().seekEpoch;
    const unsub = playbackStore.subscribe((state) => {
      if (state.seekEpoch === lastSeenEpoch || state.seekEpoch === 0) return;
      lastSeenEpoch = state.seekEpoch;
      // Arm the seek-target gate with the target as FILETIME PTS
      // (100ns ticks since 1601-01-01). Native drops pending pre-scrub
      // feeds whose PTS is far behind the target.
      const FILETIME_UNIX_OFFSET_SEC = 11644473600;
      const targetPts =
        (state.currentTime + FILETIME_UNIX_OFFSET_SEC) * 10_000_000;
      viewRef.current?.flush(targetPts).catch(() => {});
      const rate = state.isPlaying ? state.speed : 0;
      viewRef.current?.setSpeed(rate).catch(() => {});
    });
    return unsub;
  }, []);

  return { viewRef, hasFirstFrame };
}
