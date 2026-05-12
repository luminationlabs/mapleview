/**
 * Probe 13 — does `observedGopSec` drift over sustained 8x playback?
 *
 * `playback-connection.ts` infers the GOP length from the median PTS delta
 * between consecutive keyframes (`recentGopSamples`, size 5, filtered to
 * `0.1 < delta < 30`). That median feeds `schedulePacedAck`'s
 * `targetGap = 3 × gopSec × 1000 / speed`, so if the median drifts
 * upward the effective keyframe-mode rate drops below the requested
 * speed. User reports 8x getting "jumpy" over minutes of sustained
 * playback, and other speeds becoming rough afterwards — the hypothesis
 * is that occasional server-side delivery delays push >2s samples into
 * the buffer and skew the median upward.
 *
 * This probe emulates the client's GOP observation and ACK cadence on a
 * real playback session, then reports whether the running median drifts.
 * It does NOT modify anything — just measures.
 *
 * Protocol:
 *   1. Login + open playback task in keyframe mode (same as probe 10).
 *   2. ACK every ~750ms (matching 8x at 2s GOP — 3 keyframes per ACK ×
 *      2s GOP / 750ms wall = 8× effective).
 *   3. For every inbound keyframe, compute `deltaSec` vs. previous kf
 *      PTS, apply the same `0.1 < delta < 30` filter the client uses,
 *      push to a rolling window of size 5, compute the sorted-middle
 *      median. Log the median every 15s.
 *   4. Run for 5 minutes.
 *   5. Report median at key intervals + max observed.
 *
 * Expected if the hypothesis is right: median starts ~2s and drifts
 * upward as stray large-delta samples accumulate. A drift from 2s to
 * 3-4s would halve the effective rate at 8x, matching user report.
 * If the median stays rock-steady at 2s for 5 full minutes, the drift
 * hypothesis is dead and we look elsewhere.
 */
import WebSocket from "ws";
import {
  loadCredentials,
  login,
  pickChannelId,
  sleep,
  writeResult,
  watchdog,
} from "./harness";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL } from "../../shfl";

/** Mirror the JS client's ACK cadence at 8x for a 2s GOP
 *  (3 × GOP × 1000 / speed = 750ms). */
const ACK_GAP_MS = Number(process.env.PROBE_ACK_GAP_MS ?? 750);
/** Observation wall-time. Default is 5 minutes to match the user's
 *  reported "after a few minutes" drift window. */
const OBSERVE_SECONDS = Number(process.env.PROBE_OBSERVE_SECONDS ?? 300);
/** How often to snapshot the running median for the drift log. */
const SNAPSHOT_INTERVAL_MS = 15_000;
/** Mirror the client: last N keyframe deltas, median of those. */
const GOP_SAMPLE_SIZE = 5;
/** Mirror the client: drop deltas outside this range. Deltas < 0.1 are
 *  duplicate-keyframe artefacts (zero or negative); deltas > 30 are
 *  scrubs or restarts (filtered by JS code too). */
const MIN_DELTA_SEC = 0.1;
const MAX_DELTA_SEC = 30;
/** Kill switch so a hung probe doesn't wedge the terminal. */
const WATCHDOG_MS = (OBSERVE_SECONDS + 45) * 1000;

const FILETIME_UNIX_OFFSET_SEC = 11644473600;

function ptsToUnixSec(pts: number): number {
  return pts / 10_000_000 - FILETIME_UNIX_OFFSET_SEC;
}

function unixToUtcTimeStr(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}:000`
  );
}

function randomU32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

function median(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

interface Snapshot {
  tSec: number;
  medianSec: number;
  samples: number[];
  keyframeCount: number;
}

async function runProbe() {
  watchdog(WATCHDOG_MS);

  const creds = loadCredentials();
  const session = await login(creds);
  console.log(
    `login ok: sessionId=${session.sessionId.slice(0, 8)} in ${session.loginMs}ms`,
  );

  const channelId = await pickChannelId(session, creds);
  console.log(`channel: ${channelId.slice(1, 9)}`);

  // Pick a wide range. Sustained 8x burns through video fast —
  // at 2s GOP × 3 kf / 750ms = 8 s/wall-s, OBSERVE_SECONDS=300 ≈ 40 min
  // of video content. Give a 2-hour cushion so we don't hit end of range.
  const now = Math.floor(Date.now() / 1000);
  const range = { start: now - 7200, end: now - 60 };
  console.log(
    `playback range: ${unixToUtcTimeStr(range.start)} .. ${unixToUtcTimeStr(range.end)} ` +
      `(ack gap ${ACK_GAP_MS}ms, observe ${OBSERVE_SECONDS}s)`,
  );

  const taskId = generateTaskId();
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let firstFrameWall: number | null = null;
  let observationStartedAt: number | null = null;
  let prevKeyframePts: number | null = null;
  const recentGopSamples: number[] = [];
  /** Every accepted delta, with timing — for post-hoc analysis. */
  const allAcceptedDeltas: { tSec: number; deltaSec: number }[] = [];
  /** Every rejected delta (outside filter) — also useful to know. */
  const rejectedDeltas: { tSec: number; deltaSec: number; reason: string }[] = [];
  const snapshots: Snapshot[] = [];
  let keyframeCount = 0;
  let pendingSeq: number | null = null;
  let ackTimer: NodeJS.Timeout | null = null;
  let snapshotTimer: NodeJS.Timeout | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      handleText(data.toString("utf-8"));
      return;
    }
    let chunk: Uint8Array;
    if (data instanceof ArrayBuffer) {
      chunk = new Uint8Array(data);
    } else if (Buffer.isBuffer(data)) {
      chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (Array.isArray(data)) {
      chunk = new Uint8Array(Buffer.concat(data));
    } else {
      return;
    }
    try {
      const wsFrame = parseWSFrame(chunk);
      const shfl = parseSHFL(wsFrame.payload);
      if (
        (shfl.frameType === 0 || shfl.frameType === 4) &&
        shfl.payload.byteLength > 0
      ) {
        const nowWall = Date.now();
        if (firstFrameWall === null) {
          firstFrameWall = nowWall;
          observationStartedAt = nowWall;
          startTimers();
        }

        if (shfl.isKeyFrame) {
          keyframeCount++;
          const ptsRaw = shfl.timestampLow + shfl.timestampHigh * 0x100000000;
          if (prevKeyframePts !== null) {
            const deltaSec = (ptsRaw - prevKeyframePts) / 10_000_000;
            const tSec = (nowWall - (firstFrameWall ?? nowWall)) / 1000;
            if (deltaSec > MIN_DELTA_SEC && deltaSec < MAX_DELTA_SEC) {
              recentGopSamples.push(deltaSec);
              if (recentGopSamples.length > GOP_SAMPLE_SIZE) {
                recentGopSamples.shift();
              }
              allAcceptedDeltas.push({
                tSec: Number(tSec.toFixed(2)),
                deltaSec: Number(deltaSec.toFixed(3)),
              });
            } else {
              rejectedDeltas.push({
                tSec: Number(tSec.toFixed(2)),
                deltaSec: Number(deltaSec.toFixed(3)),
                reason: deltaSec <= MIN_DELTA_SEC ? "too-small" : "too-large",
              });
            }
          }
          prevKeyframePts = ptsRaw;
        }

        if (shfl.seq > 0) {
          pendingSeq = shfl.seq;
        }
      }
    } catch {
      // malformed — skip
    }
  });

  function startTimers(): void {
    if (ackTimer === null) {
      ackTimer = setInterval(() => {
        if (pendingSeq !== null && ws.readyState === WebSocket.OPEN) {
          sendAck(pendingSeq);
          pendingSeq = null;
        }
        if (
          observationStartedAt !== null &&
          Date.now() - observationStartedAt >= OBSERVE_SECONDS * 1000
        ) {
          if (ackTimer) {
            clearInterval(ackTimer);
            ackTimer = null;
          }
          if (snapshotTimer) {
            clearInterval(snapshotTimer);
            snapshotTimer = null;
          }
          resolveDone();
        }
      }, ACK_GAP_MS);
    }
    if (snapshotTimer === null) {
      snapshotTimer = setInterval(() => {
        if (observationStartedAt === null) return;
        const tSec = (Date.now() - observationStartedAt) / 1000;
        const m = median(recentGopSamples);
        const snap: Snapshot = {
          tSec: Number(tSec.toFixed(1)),
          medianSec: Number(m.toFixed(3)),
          samples: [...recentGopSamples].map((s) => Number(s.toFixed(3))),
          keyframeCount,
        };
        snapshots.push(snap);
        console.log(
          `[${snap.tSec}s] median=${snap.medianSec}s samples=[${snap.samples.join(",")}] kfs=${snap.keyframeCount}`,
        );
      }, SNAPSHOT_INTERVAL_MS);
    }
  }

  function handleText(text: string): void {
    let msg: { url?: string; basic?: { code?: number; msg?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.url?.endsWith("create_connection#response")) {
      ws.send(
        JSON.stringify({
          url: "/device/playback/open",
          basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
          data: {
            task_id: taskId,
            channel_id: channelId,
            start_time: range.start,
            end_time: range.end,
            stream_index: 1,
            type_mask: [
              "manual",
              "sensor",
              "avd",
              "smart_pass_line",
              "tripwire",
              "perimeter",
              "smart_aoi_entry",
              "smart_aoi_leave",
              "motion",
              "pos",
              "schedule",
            ],
          },
        }),
      );
      ws.send(
        JSON.stringify({
          url: "/device/playback/key_frame",
          basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
          data: {
            task_id: taskId,
            frame_time: unixToUtcTimeStr(range.start),
          },
        }),
      );
      ws.send(
        JSON.stringify({
          url: "/device/playback/audio/close",
          basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
          data: { task_id: taskId },
        }),
      );
      console.log(`open+key_frame sent; observing for ${OBSERVE_SECONDS}s`);
    }
    if (
      msg.url === "/device/playback/open#response" &&
      msg.basic?.code &&
      msg.basic.code !== 0
    ) {
      console.error(
        `playback/open rejected: code=${msg.basic.code} msg=${msg.basic.msg}`,
      );
      resolveDone();
    }
  }

  function sendAck(seq: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        url: "/device/playback/refresh_play_index",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId, play_frame_index: seq },
      }),
    );
  }

  ws.on("close", () => resolveDone());
  ws.on("error", (err) => {
    console.error("ws error:", err.message);
    resolveDone();
  });

  await done;
  if (ackTimer) {
    clearInterval(ackTimer);
    ackTimer = null;
  }
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          url: "/device/playback/close",
          basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
          data: { task_id: taskId },
        }),
      );
    }
    ws.close();
  } catch {
    // best-effort
  }
  await sleep(200);

  // Derive per-snapshot drift metric: median_at_snapshot / median_at_first_stable.
  // "First stable" = first snapshot with a full sample window.
  const firstStable = snapshots.find((s) => s.samples.length >= GOP_SAMPLE_SIZE);
  const medianBaseline = firstStable ? firstStable.medianSec : 0;
  const medianMax = snapshots.reduce(
    (m, s) => (s.medianSec > m ? s.medianSec : m),
    0,
  );
  const medianFinal =
    snapshots.length > 0 ? snapshots[snapshots.length - 1].medianSec : 0;
  const driftRatio =
    medianBaseline > 0 ? medianMax / medianBaseline : 0;

  const summary = {
    ackGapMs: ACK_GAP_MS,
    observationSec: OBSERVE_SECONDS,
    keyframeCount,
    acceptedDeltaCount: allAcceptedDeltas.length,
    rejectedDeltaCount: rejectedDeltas.length,
    medianBaselineSec: medianBaseline,
    medianFinalSec: medianFinal,
    medianMaxSec: medianMax,
    driftRatio: Number(driftRatio.toFixed(2)),
    // If any deltas > 2.5s slipped through the filter, they're the most
    // likely culprits — surface them so we can see their distribution.
    largeDeltas: allAcceptedDeltas.filter((d) => d.deltaSec > 2.5),
    rejectedSample: rejectedDeltas.slice(0, 20),
    snapshots,
  };

  const verdict =
    driftRatio >= 1.3
      ? `Median drifted ${driftRatio.toFixed(2)}× from baseline ${medianBaseline.toFixed(2)}s to peak ${medianMax.toFixed(2)}s. Hypothesis supported — filter is too permissive under sustained 8x.`
      : driftRatio >= 1.1
        ? `Mild drift (${driftRatio.toFixed(2)}×). Hypothesis partially supported — monitor for longer or under load.`
        : `No meaningful drift (${driftRatio.toFixed(2)}×). Median held near ${medianBaseline.toFixed(2)}s. Hypothesis NOT supported — the user's 8x jumpiness is caused by something else.`;

  console.log(`\n=== summary ===`);
  console.log(
    `keyframes: ${keyframeCount} (${allAcceptedDeltas.length} deltas accepted, ${rejectedDeltas.length} rejected)`,
  );
  console.log(
    `median baseline=${medianBaseline.toFixed(2)}s → final=${medianFinal.toFixed(2)}s (max seen ${medianMax.toFixed(2)}s, drift ${driftRatio.toFixed(2)}×)`,
  );
  if (summary.largeDeltas.length > 0) {
    console.log(
      `large deltas (>2.5s): ${summary.largeDeltas.length} occurrences`,
    );
    for (const d of summary.largeDeltas.slice(0, 10)) {
      console.log(`  [${d.tSec}s] delta=${d.deltaSec}s`);
    }
  }
  console.log(`\n${verdict}`);

  writeResult("13-gop-drift-long-8x", { ...summary, verdict });
}

runProbe().catch((err) => {
  console.error(err);
  process.exit(1);
});
