import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useUIStore } from "@/src/store/ui-store";
import { usePlaybackStore } from "@/src/store/playback-store";

/** Sliding window of feed samples used to compute effective rate. 5 s
 *  smooths the 750 ms keyframe bursts at 8× while staying short enough
 *  that the number moves quickly when pacing changes after a scrub. */
const WINDOW_MS = 5000;
/** Inter-keyframe gaps larger than this separate ACK bursts. Within a
 *  burst at 4K/stream-0, keyframes arrive 50–150 ms apart; between bursts
 *  ≥500 ms at 8×, ≥1500 ms at 4×. 300 ms is well below either threshold. */
const BETWEEN_BURST_THRESHOLD_MS = 300;
/** Recompute cadence. 500 ms keeps the display from flickering but stays
 *  responsive enough to see a rate drop within a second of it happening. */
const RECOMPUTE_INTERVAL_MS = 500;
/** Windows FILETIME epoch offset — PTS is 100 ns since 1601-01-01. */
const FILETIME_UNIX_OFFSET_SEC = 11644473600;

interface Sample {
  wallMs: number;
  ptsSec: number;
  bytes: number;
  isKeyFrame: boolean;
}

interface Stats {
  effectiveRate: number;
  fps: number;
  mbps: number;
  /** "kf" if every observed frame was a keyframe (keyframe-only mode),
   *  otherwise "all-frame". */
  mode: "kf" | "all";
  /** Median PTS delta between consecutive keyframes, seconds. null if we
   *  only saw one keyframe in the window. */
  gopSec: number | null;
  /** Keyframes per wall second over the window. */
  kfPerSec: number;
  /** ACK cycles per wall second — derived from the count of inter-keyframe
   *  gaps ≥ BETWEEN_BURST_THRESHOLD_MS. One burst ≈ one ACK. */
  ackPerSec: number;
  /** Median gap between ACK bursts, ms. Should equal the target ACK gap
   *  (750 ms at 8×, 1500 ms at 4×). Null if < 2 bursts observed. */
  burstGapMs: number | null;
}

/**
 * Returns an `onFrame` callback to hand to usePlayback() and an overlay
 * element to render beside the video. Both are no-ops when Debug Mode is off.
 *
 * Effective rate = PTS advance / wall advance over a sliding window. If the
 * server is delivering what the user requested (4×, 8×, …) this tracks the
 * playback-store `speed`. A gap between the two is the signal to chase a
 * pacing/server/bandwidth bottleneck.
 */
export function usePlaybackRateOverlay(): {
  onFrame: (isKeyFrame: boolean, pts: number, bytes: number) => void;
  overlay: React.ReactNode;
} {
  const debugMode = useUIStore((s) => s.debugMode);
  const targetSpeed = usePlaybackStore((s) => s.speed);
  const insets = useSafeAreaInsets();
  const samplesRef = useRef<Sample[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);

  const onFrame = useCallback((isKeyFrame: boolean, pts: number, bytes: number) => {
    const wallMs = Date.now();
    const ptsSec = pts / 10_000_000 - FILETIME_UNIX_OFFSET_SEC;
    const s = samplesRef.current;
    s.push({ wallMs, ptsSec, bytes, isKeyFrame });
    const cutoff = wallMs - WINDOW_MS;
    while (s.length > 1 && s[0].wallMs < cutoff) s.shift();
  }, []);

  useEffect(() => {
    if (!debugMode) {
      setStats(null);
      samplesRef.current = [];
      return;
    }
    const iv = setInterval(() => {
      const s = samplesRef.current;
      if (s.length < 2) {
        setStats(null);
        return;
      }
      const first = s[0];
      const last = s[s.length - 1];
      const wallSec = (last.wallMs - first.wallMs) / 1000;
      if (wallSec < 0.3) return;
      const ptsDelta = last.ptsSec - first.ptsSec;
      let totalBytes = 0;
      let kfCount = 0;
      const keyframes: { wallMs: number; ptsSec: number }[] = [];
      for (const sample of s) {
        totalBytes += sample.bytes;
        if (sample.isKeyFrame) {
          kfCount++;
          keyframes.push({ wallMs: sample.wallMs, ptsSec: sample.ptsSec });
        }
      }
      const kfRatio = kfCount / s.length;
      // "kf" mode: every frame is a keyframe (the server only emits IDRs).
      // Some tolerance for the 1-2 non-IDR post-restart frames that sneak in.
      const mode: "kf" | "all" = kfRatio > 0.9 ? "kf" : "all";
      let gopSec: number | null = null;
      if (keyframes.length >= 2) {
        const ptsGaps: number[] = [];
        for (let i = 1; i < keyframes.length; i++) {
          ptsGaps.push(keyframes[i].ptsSec - keyframes[i - 1].ptsSec);
        }
        ptsGaps.sort((a, b) => a - b);
        gopSec = ptsGaps[Math.floor(ptsGaps.length / 2)];
      }
      // ACK cadence: keyframes arrive in bursts after each ACK response.
      // Count the inter-keyframe wall gaps that exceed the burst threshold,
      // and also report the median gap — this should match the JS side's
      // targetAckGap (750 ms at 8×, 1500 ms at 4×). A spread between those
      // tells us whether the client is firing ACKs late or the server is
      // releasing fewer keyframes per ACK.
      let burstCount = 0;
      const betweenBurstGaps: number[] = [];
      for (let i = 1; i < keyframes.length; i++) {
        const gapMs = keyframes[i].wallMs - keyframes[i - 1].wallMs;
        if (gapMs >= BETWEEN_BURST_THRESHOLD_MS) {
          burstCount++;
          betweenBurstGaps.push(gapMs);
        }
      }
      let burstGapMs: number | null = null;
      if (betweenBurstGaps.length >= 1) {
        betweenBurstGaps.sort((a, b) => a - b);
        burstGapMs = betweenBurstGaps[Math.floor(betweenBurstGaps.length / 2)];
      }
      setStats({
        effectiveRate: ptsDelta / wallSec,
        fps: (s.length - 1) / wallSec,
        mbps: (totalBytes * 8) / (wallSec * 1_000_000),
        mode,
        gopSec,
        kfPerSec: kfCount / wallSec,
        ackPerSec: burstCount / wallSec,
        burstGapMs,
      });
    }, RECOMPUTE_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [debugMode]);

  // Position: top-right, below the top-chrome bar. The chrome uses
  // paddingTop: 54 to clear the iPhone dynamic island / status bar and is
  // ~82 pt tall overall; `insets.top + 72` sits just under that in portrait
  // and drops to ~72 pt in landscape (insets.top ≈ 0) — clear of the
  // landscape-mode chrome as well.
  const topOffset = insets.top + 72;

  const overlay = debugMode ? (
    <View style={[styles.container, { top: topOffset }]} pointerEvents="none">
      <Text style={styles.primary}>
        {stats ? `${stats.effectiveRate.toFixed(2)}×` : "—"}
        <Text style={styles.dim}>  (target {targetSpeed}×)</Text>
      </Text>
      <Text style={styles.secondary}>
        {stats
          ? `${stats.fps.toFixed(1)} fps · ${stats.mbps.toFixed(1)} Mbit/s`
          : "waiting for frames…"}
      </Text>
      {stats && (
        <>
          <Text style={styles.secondary}>
            {stats.mode} · gop {stats.gopSec ? `${stats.gopSec.toFixed(2)}s` : "—"} · {stats.kfPerSec.toFixed(1)} kf/s
          </Text>
          <Text style={styles.secondary}>
            ack {stats.ackPerSec.toFixed(2)}/s
            {stats.burstGapMs != null ? ` · burst gap ${Math.round(stats.burstGapMs)} ms` : ""}
          </Text>
        </>
      )}
    </View>
  ) : null;

  return { onFrame, overlay };
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    right: 8,
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    minWidth: 190,
  },
  primary: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  dim: {
    color: "#B0B0B0",
    fontWeight: "400",
  },
  secondary: {
    color: "#B0B0B0",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    marginTop: 1,
  },
});
