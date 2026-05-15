import { createStore } from "zustand/vanilla";
import type { RecordingSegment, TimeRange } from "../nvr/types";
import { utcTimeStrToUnix } from "../utils/time";
import { todayStr } from "../utils/calendar";

/**
 * Return the segment covering `unixTime`, or null if it falls in a gap.
 * Segment strings are parsed with `utcTimeStrToUnix` to match the
 * convention used by `computeCompositeSegments` (despite `queryChlRecLog`
 * returning local-time strings, treating them as UTC has been load-bearing
 * for both the composite timeline and the display-time math).
 */
export function segmentCoveringTime(
  segments: RecordingSegment[] | undefined,
  unixTime: number,
): RecordingSegment | null {
  if (!segments || segments.length === 0) return null;
  for (const seg of segments) {
    const start = utcTimeStrToUnix(seg.startTime);
    const end = utcTimeStrToUnix(seg.endTime);
    if (unixTime >= start && unixTime <= end) return seg;
  }
  return null;
}

/**
 * Merge overlapping or adjacent time ranges into a minimal union set.
 * Input does not need to be sorted.
 */
export function mergeTimeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end) {
      // Overlapping or adjacent — extend
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

export interface PlaybackState {
  currentTime: number;           // Unix seconds UTC — playback position
  isPlaying: boolean;
  speed: 1 | 2 | 4 | 8;
  selectedDate: string;          // "YYYY-MM-DD" (local)

  // True when `selectedDate` represents the live-recording edge ("today"
  // at the time it was set). False once the user explicitly picks a
  // historical date. Drives day-rollover behavior in
  // useTimelineAutoRefresh: when this is true and `todayStr()` has moved
  // past `selectedDate`, the hook auto-advances selectedDate to the new
  // today so the timeline keeps tracking the recording edge.
  followLiveEdge: boolean;

  // Per-camera segments keyed by channelId
  cameraSegments: Record<string, RecordingSegment[]>;

  // Composite segments (union of visible cameras' recordings)
  compositeSegments: TimeRange[];

  // Loading state
  loadingSegments: boolean;

  // True once at least one segment query has completed successfully for the
  // current selected date. Distinguishes "genuinely no recordings" from "we
  // haven't been able to ask the NVR yet" — the UI uses this to keep showing
  // a spinner instead of a misleading empty-state message during the window
  // between tab mount and first successful query.
  hasQueriedSegments: boolean;

  // Per-channel "video stream is in transition" flag — true while a connection
  // is between restart() and its first delivered frame. UI shows a spinner so
  // the user sees a clean loading state instead of a green decoder artifact.
  loadingChannels: Record<string, boolean>;

  // Per-channel "open failed after retries exhausted" flag. Set by
  // playback-manager when openOneInner's retry chain gives up without
  // receiving any frame; cleared on the next successful open attempt
  // for the channel. UI shows a retryable error state instead of an
  // infinite spinner — otherwise a pre-frame WS failure on resume
  // leaves the tile/single-cam sitting on a spinner forever.
  failedChannels: Record<string, boolean>;

  // Monotonic counter bumped on every seek. Views subscribe to this and flush
  // their display layer when it changes, which clears pre-scrub queued samples
  // that would otherwise bleed through (most visible as the "stuck camera
  // comes back with the previous frame after scrub" symptom).
  seekEpoch: number;

  // Actions
  setCurrentTime: (t: number) => void;
  setPlaying: (v: boolean) => void;
  setSpeed: (s: 1 | 2 | 4 | 8) => void;
  setSelectedDate: (d: string) => void;
  setCameraSegments: (channelId: string, segments: RecordingSegment[]) => void;
  clearSegments: () => void;
  setLoadingSegments: (v: boolean) => void;
  setHasQueriedSegments: (v: boolean) => void;
  setChannelLoading: (channelId: string, loading: boolean) => void;
  setChannelFailed: (channelId: string, failed: boolean) => void;
  computeCompositeSegments: (visibleChannelIds: string[]) => void;
  bumpSeekEpoch: () => void;
}

export const playbackStore = createStore<PlaybackState>((set, get) => ({
  currentTime: 0,
  isPlaying: false,
  speed: 1,
  selectedDate: todayStr(),
  followLiveEdge: true,
  cameraSegments: {},
  compositeSegments: [],
  loadingSegments: false,
  hasQueriedSegments: false,
  loadingChannels: {},
  failedChannels: {},
  seekEpoch: 0,

  setCurrentTime: (t: number) => set({ currentTime: t }),
  setPlaying: (v: boolean) => set({ isPlaying: v }),
  setSpeed: (s: 1 | 2 | 4 | 8) => set({ speed: s }),
  bumpSeekEpoch: () =>
    set((state) => ({ seekEpoch: state.seekEpoch + 1 })),
  setSelectedDate: (d: string) =>
    set({ selectedDate: d, followLiveEdge: d === todayStr() }),

  setCameraSegments: (channelId: string, segments: RecordingSegment[]) =>
    set((state) => ({
      cameraSegments: { ...state.cameraSegments, [channelId]: segments },
    })),

  clearSegments: () =>
    set({ cameraSegments: {}, compositeSegments: [], hasQueriedSegments: false }),

  setLoadingSegments: (v: boolean) => set({ loadingSegments: v }),

  setHasQueriedSegments: (v: boolean) => set({ hasQueriedSegments: v }),

  setChannelLoading: (channelId: string, loading: boolean) =>
    set((state) => {
      if (Boolean(state.loadingChannels[channelId]) === loading) return {};
      return {
        loadingChannels: { ...state.loadingChannels, [channelId]: loading },
      };
    }),

  setChannelFailed: (channelId: string, failed: boolean) =>
    set((state) => {
      if (Boolean(state.failedChannels[channelId]) === failed) return {};
      return {
        failedChannels: { ...state.failedChannels, [channelId]: failed },
      };
    }),

  computeCompositeSegments: (visibleChannelIds: string[]) => {
    const { cameraSegments } = get();
    const allRanges: TimeRange[] = [];

    for (const channelId of visibleChannelIds) {
      const segments = cameraSegments[channelId];
      if (!segments) continue;
      for (const seg of segments) {
        allRanges.push({
          start: utcTimeStrToUnix(seg.startTime),
          end: utcTimeStrToUnix(seg.endTime),
        });
      }
    }

    const compositeSegments = mergeTimeRanges(allRanges);
    set({ compositeSegments });
  },
}));

// React hook (lazy import avoids issues in non-React test contexts)
let _usePlaybackStore: typeof import("zustand").useStore | null = null;

export function usePlaybackStore(): PlaybackState;
export function usePlaybackStore<T>(selector: (state: PlaybackState) => T): T;
export function usePlaybackStore<T>(selector?: (state: PlaybackState) => T) {
  if (!_usePlaybackStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useStore } = require("zustand") as typeof import("zustand");
    _usePlaybackStore = useStore;
  }
  const useStore = _usePlaybackStore;
  return selector
    ? useStore(playbackStore, selector)
    : useStore(playbackStore);
}
