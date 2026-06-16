import type { StyleProp, ViewStyle } from 'react-native';

export type OnFeedPayload = {
  bytes: number;
  isKeyframe: boolean;
  pts: number;
};

/**
 * Decoder error event. The native view de-duplicates by `code` so a
 * persistent failure produces a single event until conditions change.
 *
 *   "timebase_init"     — CMTimebase creation failed at init. Fatal —
 *                         the view will not pace samples.
 *   "layer_failed"      — AVSampleBufferDisplayLayer entered .failed.
 *                         Auto-recovers on the next keyframe; the
 *                         tile may show a brief blank frame.
 *   "format_description"— SPS/PPS or VPS/SPS/PPS couldn't build a
 *                         CMVideoFormatDescription. Next keyframe
 *                         retries; until then no frames render.
 *   "sample_buffer"     — CMBlockBuffer / CMSampleBufferCreateReady
 *                         failed. Likely memory pressure. Frame skipped.
 */
export type OnErrorPayload = {
  code:
    | 'timebase_init'
    | 'layer_failed'
    | 'format_description'
    | 'sample_buffer';
  message: string;
};

/**
 * Stream presentation dimensions, parsed from the SPS when a keyframe
 * builds a new format description. Pixel-aspect-ratio and clean-aperture
 * corrected, so `width / height` is the display aspect ratio of what the
 * native layer actually letterboxes. Fires once per size change (the
 * native side de-duplicates the per-keyframe re-parses).
 */
export type OnVideoSizePayload = {
  width: number;
  height: number;
};

export type NvrVideoViewProps = {
  backgroundHex?: string;
  /**
   * Currently a no-op: onFeed fires per frame, so it is deliberately not
   * declared as a view event on the native side — declaring it would pay
   * a per-frame native→JS dispatch even with no listener. Declare it in
   * NvrVideoViewModule.swift's Events() before consuming this prop.
   */
  onFeed?: (event: { nativeEvent: OnFeedPayload }) => void;
  onError?: (event: { nativeEvent: OnErrorPayload }) => void;
  onVideoSize?: (event: { nativeEvent: OnVideoSizePayload }) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * Methods exposed on the view's ref. The native side attaches these as
 * AsyncFunction entries inside View(…) — Expo Modules surfaces them on the
 * React ref of the hosted component. All return Promises.
 */
export type NvrVideoViewRef = {
  feed: (data: Uint8Array, isKeyframe: boolean, pts: number) => Promise<void>;
  /**
   * Clear the display layer and reset decoder state. `targetPts` (FILETIME
   * 100ns ticks, 0 = no gate) arms a native-side gate that drops pending
   * pre-scrub feeds still in flight on the bridge. Use 0 for non-scrub
   * flushes (mode upgrade resync).
   */
  flush: (targetPts: number) => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  /**
   * Arm the keyframe gate without flushing. Subsequent non-keyframe feeds
   * are dropped until the next IDR. Use after a delivery gap where the
   * decoder's reference chain may have been broken (e.g., live re-attach
   * after a paged-out window) to avoid green frames from stale references.
   */
  markPotentialGap: () => Promise<void>;
};
