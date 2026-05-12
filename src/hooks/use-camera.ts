import { useCallback, useEffect, useRef, useState } from "react";
import { nvrClient } from "../nvr/client";
import { useLifecycleStore } from "../store/lifecycle-store";
import type { StreamMode } from "../nvr/types";
import type { NvrVideoViewRef } from "../../modules/nvr-video-view";

/**
 * Hook that attaches a camera stream to an NvrVideoView ref.
 *
 * Returns a ref to pass to <NvrVideoView>, and a `hasFirstFrame` flag that
 * flips true once the first video frame has reached the view. Callers can
 * use that to show a spinner while the native view is still blank (the
 * camera-store status often transitions from "online" (from enumerate)
 * straight back to "online" (from first frame), with a gap where nothing
 * is rendered — leaving the view black instead of spinning).
 */
export function useCamera(channelId: string, mode: StreamMode) {
  const viewRef = useRef<NvrVideoViewRef>(null);
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const seenFrameRef = useRef(false);

  const sink = useCallback(
    (nal: Uint8Array, isKeyFrame: boolean, pts: number) => {
      // Copy the subarray to a fresh Uint8Array — the Expo bridge may not
      // handle subarrays (views into a shared ArrayBuffer) correctly.
      const copy = nal.byteOffset !== 0 || nal.byteLength !== nal.buffer.byteLength
        ? new Uint8Array(nal)
        : nal;
      viewRef.current?.feed(copy, isKeyFrame, pts);
      if (!seenFrameRef.current) {
        seenFrameRef.current = true;
        setHasFirstFrame(true);
      }
    },
    [],
  );

  useEffect(() => {
    if (!channelId) return;

    seenFrameRef.current = false;
    setHasFirstFrame(false);
    // Arm the native keyframe gate. The detach-grace window in StreamRegistry
    // sets the connection's sink to a no-op and may swallow an IDR before we
    // re-attach (paged grid swiping back inside 1500ms). Without the gate,
    // the next P-frame to arrive would decode against the stale
    // formatDescription and render green. The gate keeps the last-rendered
    // frame visible until the next IDR re-establishes references.
    viewRef.current?.markPotentialGap().catch(() => {});
    nvrClient.attach(channelId, mode, sink);

    return () => {
      nvrClient.detach(channelId, mode);
    };
  }, [channelId, mode, sink]);

  // On foreground after a background teardown, the manager reopens the
  // stream but the native view is still holding the last-rendered frame
  // and hasFirstFrame is still true from before. Reset both so the
  // caller-visible spinner sits over solid black during the reopen.
  const foregroundEpoch = useLifecycleStore((s) => s.foregroundEpoch);
  useEffect(() => {
    if (foregroundEpoch === 0) return;
    seenFrameRef.current = false;
    setHasFirstFrame(false);
    viewRef.current?.flush(0).catch(() => {});
  }, [foregroundEpoch]);

  return { viewRef, hasFirstFrame };
}
