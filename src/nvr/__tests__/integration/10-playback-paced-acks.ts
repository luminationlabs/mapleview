/**
 * Probe 10 — does paced ACK'ing actually throttle the NVR's keyframe
 * delivery rate to the target display cadence?
 *
 * Probe 09 showed the server happily delivers at ~127x wall-rate when we
 * ACK every frame immediately (our current code at 8x). That overruns the
 * display layer's queue by 20-30× consumption rate and manifests as the
 * "1 fps with 8s jumps" bug — iOS drops most samples.
 *
 * The hypothesized fix is to ACK at a cadence matched to the target
 * display rate — e.g. 250ms gap for 8x playback with 2s GOP (= 4 frames/
 * wall-second × 2s PTS each = 8s PTS per wall-second = 8x effective).
 *
 * This probe verifies two things:
 *   (a) The server responds to paced ACKs by delivering at the paced
 *       rate. If it delivers a full window regardless, we need a
 *       different throttling strategy.
 *   (b) The paced rate is steady over ≥30s (no burst-and-settle like 09
 *       showed).
 *
 * Protocol:
 *   1. Login, open playback WS, enter keyframe mode. (Same as probe 09.)
 *   2. Buffer incoming frames; do NOT ACK immediately.
 *   3. Tick a timer every ACK_GAP_MS. On each tick, if we have a buffered
 *      frame, ACK its seq and clear the buffer. If no buffered frame yet,
 *      wait for next tick.
 *   4. Observe for OBSERVE_SECONDS wall-time. Record per-frame arrival
 *      timing + PTS as probe 09 did.
 *   5. Compare observed rate to the target.
 *
 * Expected if the fix is valid: inter-arrival gaps should cluster near
 * ACK_GAP_MS, effective rate should be ≈ 8x (not 127x), no bursts.
 */
import WebSocket from "ws";
import {
  loadCredentials,
  login,
  pickChannelId,
  sleep,
  writeResult,
  watchdog,
  defaultPlaybackRange,
} from "./harness";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL } from "../../shfl";

/** Target ACK cadence (ms). Override via env var PROBE_ACK_GAP_MS to
 *  sweep across values — running at several gaps tells us whether
 *  frames-per-ACK is constant (tunable ACK gap = tunable rate) or
 *  variable (need JS-side frame drop). */
const ACK_GAP_MS = Number(process.env.PROBE_ACK_GAP_MS ?? 250);
/** Which stream to open. 0 = original recording (current single-cam default),
 *  1 = transcoded-for-wasm. Override via PROBE_STREAM_INDEX. */
const STREAM_INDEX = Number(process.env.PROBE_STREAM_INDEX ?? 0);
/** How long to observe. */
const OBSERVE_SECONDS = 30;
/** Kill switch so a hung probe doesn't wedge the CI / terminal. */
const WATCHDOG_MS = (OBSERVE_SECONDS + 45) * 1000;
/** Expected target effective playback rate (8x of 2s GOP = 8x). Used for
 *  the verdict line — compares against the observed effective rate. */
const TARGET_EFFECTIVE_RATE_X = 8;

interface FrameRecord {
  arrivalWallMs: number;
  ptsUnixSec: number;
  seq: number;
  frameType: number;
  isKeyFrame: boolean;
  /** Whether an ACK was triggered on this frame (vs buffered for later). */
  ackedOnArrival: boolean;
}

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

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function runProbe() {
  watchdog(WATCHDOG_MS);

  const creds = loadCredentials();
  const session = await login(creds);
  console.log(`login ok: sessionId=${session.sessionId.slice(0, 8)} in ${session.loginMs}ms`);

  const channelId = await pickChannelId(session, creds);
  console.log(`channel: ${channelId.slice(1, 9)}`);

  // Use a wider range than probe 09 — 2 hours instead of 15 minutes — so
  // we don't exhaust it mid-observation at 8x effective rate.
  const now = Math.floor(Date.now() / 1000);
  const range = { start: now - 7200, end: now - 60 };
  console.log(
    `playback range: ${unixToUtcTimeStr(range.start)} .. ${unixToUtcTimeStr(range.end)} ` +
    `(spans ${range.end - range.start}s; target ack gap ${ACK_GAP_MS}ms)`,
  );

  const taskId = generateTaskId();
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  const frames: FrameRecord[] = [];
  let firstFrameWall: number | null = null;
  let observationStartedAt: number | null = null;
  let ackCount = 0;

  // Pending frame buffer — holds the most-recent received frame's seq until
  // the ACK timer fires. If multiple frames arrive within one ACK window,
  // only the most recent seq is ACK'd (the server advances past the earlier
  // ones implicitly).
  let pendingSeq: number | null = null;
  let ackTimer: NodeJS.Timeout | null = null;

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString("utf-8");
      handleText(text);
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
          startAckTimer();
        }
        const ptsRaw = shfl.timestampLow + shfl.timestampHigh * 0x100000000;
        const ptsUnix = ptsToUnixSec(ptsRaw);
        frames.push({
          arrivalWallMs: nowWall - firstFrameWall,
          ptsUnixSec: ptsUnix,
          seq: shfl.seq,
          frameType: shfl.frameType,
          isKeyFrame: !!shfl.isKeyFrame,
          ackedOnArrival: false,
        });
        const ordinal = frames.length;
        const wallS = ((nowWall - firstFrameWall) / 1000).toFixed(2);
        if (ordinal <= 5 || ordinal % 10 === 0) {
          console.log(
            `[${wallS}s] #${ordinal} seq=${shfl.seq} pts=${ptsUnix.toFixed(3)}`,
          );
        }
        // Buffer the seq for the next ACK-timer tick. Overwrites any
        // older pending — the NVR advances past earlier seqs when we ACK
        // a later one.
        if (shfl.seq > 0) {
          pendingSeq = shfl.seq;
        }
      }
    } catch {
      // malformed — skip
    }
  });

  function startAckTimer(): void {
    if (ackTimer) return;
    ackTimer = setInterval(() => {
      if (pendingSeq != null && ws.readyState === WebSocket.OPEN) {
        sendAck(pendingSeq);
        pendingSeq = null;
        ackCount++;
      }
      // Observation deadline.
      if (observationStartedAt !== null && Date.now() - observationStartedAt >= OBSERVE_SECONDS * 1000) {
        if (ackTimer) { clearInterval(ackTimer); ackTimer = null; }
        resolveDone();
      }
    }, ACK_GAP_MS);
  }

  function handleText(text: string): void {
    let msg: { url?: string; basic?: { code?: number; msg?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.url?.endsWith("create_connection#response")) {
      ws.send(JSON.stringify({
        url: "/device/playback/open",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskId,
          channel_id: channelId,
          start_time: range.start,
          end_time: range.end,
          stream_index: STREAM_INDEX,
          type_mask: [
            "manual", "sensor", "avd", "smart_pass_line", "tripwire",
            "perimeter", "smart_aoi_entry", "smart_aoi_leave", "motion",
            "pos", "schedule",
          ],
        },
      }));
      ws.send(JSON.stringify({
        url: "/device/playback/key_frame",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskId,
          frame_time: unixToUtcTimeStr(range.start),
        },
      }));
      ws.send(JSON.stringify({
        url: "/device/playback/audio/close",
        basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId },
      }));
      console.log(`sent open+key_frame+audio/close; observing for ${OBSERVE_SECONDS}s`);
    }
    if (msg.url === "/device/playback/open#response" && msg.basic?.code && msg.basic.code !== 0) {
      console.error(`playback/open rejected: code=${msg.basic.code} msg=${msg.basic.msg}`);
      resolveDone();
    }
  }

  function sendAck(seq: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      url: "/device/playback/refresh_play_index",
      basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
      data: { task_id: taskId, play_frame_index: seq },
    }));
  }

  ws.on("close", () => { resolveDone(); });
  ws.on("error", (err) => { console.error("ws error:", err.message); resolveDone(); });

  await done;
  if (ackTimer) { clearInterval(ackTimer); ackTimer = null; }

  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        url: "/device/playback/close",
        basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId },
      }));
    }
    ws.close();
  } catch {
    // best-effort
  }
  await sleep(200);

  if (frames.length < 2) {
    console.error(`only ${frames.length} frames received — insufficient data`);
    writeResult("10-playback-paced-acks", {
      ackGapMs: ACK_GAP_MS,
      frameCount: frames.length,
      frames,
      verdict: "INSUFFICIENT_DATA",
    });
    process.exit(frames.length === 0 ? 1 : 0);
  }

  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    gaps.push(frames[i].arrivalWallMs - frames[i - 1].arrivalWallMs);
  }
  const gapsSorted = [...gaps].sort((a, b) => a - b);

  const ptsGaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    ptsGaps.push(frames[i].ptsUnixSec - frames[i - 1].ptsUnixSec);
  }
  const ptsGapsSorted = [...ptsGaps].sort((a, b) => a - b);

  const totalPtsSpan = frames[frames.length - 1].ptsUnixSec - frames[0].ptsUnixSec;
  const totalWallSec = frames[frames.length - 1].arrivalWallMs / 1000;
  const effectiveRate = totalWallSec > 0 ? totalPtsSpan / totalWallSec : 0;

  // Windowed rate (2s windows so we see steady-state).
  const windowMs = 2000;
  const windows: { tSec: number; ptsDeltaSec: number; frames: number }[] = [];
  for (let t = 0; t + windowMs <= frames[frames.length - 1].arrivalWallMs; t += windowMs) {
    const inWindow = frames.filter(
      (f) => f.arrivalWallMs >= t && f.arrivalWallMs < t + windowMs,
    );
    if (inWindow.length < 2) continue;
    const delta = inWindow[inWindow.length - 1].ptsUnixSec - inWindow[0].ptsUnixSec;
    windows.push({ tSec: t / 1000, ptsDeltaSec: delta, frames: inWindow.length });
  }

  const summary = {
    ackGapMs: ACK_GAP_MS,
    targetEffectiveRateX: TARGET_EFFECTIVE_RATE_X,
    frameCount: frames.length,
    ackCount,
    observationWallSec: Number(totalWallSec.toFixed(2)),
    totalPtsSpanSec: Number(totalPtsSpan.toFixed(2)),
    effectiveRateX: Number(effectiveRate.toFixed(2)),
    interArrivalGapsMs: {
      p50: gapsSorted[Math.floor(gapsSorted.length * 0.5)],
      p95: quantile(gapsSorted, 0.95),
      min: gapsSorted[0],
      max: gapsSorted[gapsSorted.length - 1],
      mean: Number((gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)),
    },
    ptsGapsSec: {
      p50: Number(quantile(ptsGapsSorted, 0.5).toFixed(3)),
      p95: Number(quantile(ptsGapsSorted, 0.95).toFixed(3)),
      min: Number(ptsGapsSorted[0].toFixed(3)),
      max: Number(ptsGapsSorted[ptsGapsSorted.length - 1].toFixed(3)),
    },
    windowsPerTwoSec: windows.map((w) => ({
      t: w.tSec,
      ptsDelta: Number(w.ptsDeltaSec.toFixed(2)),
      kf: w.frames,
    })),
    frames,
  };

  const rateDiff = Math.abs(effectiveRate - TARGET_EFFECTIVE_RATE_X);
  const verdict =
    rateDiff <= 2
      ? `Paced ACKs work. Effective ~${effectiveRate.toFixed(1)}x matches target ${TARGET_EFFECTIVE_RATE_X}x. Fix is viable — apply paced ACKs in keyframe mode.`
      : effectiveRate > TARGET_EFFECTIVE_RATE_X + 2
        ? `Paced ACKs DO NOT throttle the server. Observed ${effectiveRate.toFixed(1)}x » target ${TARGET_EFFECTIVE_RATE_X}x — server delivers bursts regardless. Need a different throttling strategy (e.g. drop samples in JS before enqueue).`
        : `Paced ACKs over-throttle. Observed ${effectiveRate.toFixed(1)}x < target ${TARGET_EFFECTIVE_RATE_X}x — server waits for each ACK strictly, and the 250ms gap isn't packing frames as expected. May need per-GOP adjustment.`;

  console.log(`\n=== summary ===`);
  console.log(`frames: ${frames.length} over ${totalWallSec.toFixed(2)}s wall`);
  console.log(`PTS span: ${totalPtsSpan.toFixed(2)}s → effective rate ${effectiveRate.toFixed(2)}x (target ${TARGET_EFFECTIVE_RATE_X}x)`);
  console.log(`inter-arrival gap (ms): p50=${summary.interArrivalGapsMs.p50} p95=${summary.interArrivalGapsMs.p95} min=${summary.interArrivalGapsMs.min} max=${summary.interArrivalGapsMs.max}`);
  console.log(`PTS gap (s): p50=${summary.ptsGapsSec.p50} p95=${summary.ptsGapsSec.p95}`);
  console.log(`\n${verdict}`);

  writeResult("10-playback-paced-acks", { ...summary, verdict });
}

runProbe().catch((err) => {
  console.error(err);
  process.exit(1);
});
