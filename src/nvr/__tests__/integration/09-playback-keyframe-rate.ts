/**
 * Probe 09 — how fast does the NVR deliver keyframes under keyframe-only
 * playback mode?
 *
 * Motivating observation: 8x playback in the app shows "1 frame per ~1s
 * wall with GOP-worth of jump each time". Expected 8x with a 5s GOP is
 * 1 keyframe per 0.625s wall (1.6 fps). If the server actually sustains
 * that rate, the bug is client-side (pacing / display layer). If the
 * server can only deliver at ~1 kf/s, the "1 fps" observation is server-
 * limited and no client fix will make it faster.
 *
 * What the probe does:
 *   1. Login, open a single playback WS on `main` stream for the
 *      configured channel at a range ~30 minutes before the server's
 *      current time (enough historical content to avoid live-edge).
 *   2. After the playback/open ack, switch the server into keyframe-only
 *      mode via /device/playback/key_frame.
 *   3. ACK every arriving keyframe immediately (matches the app's
 *      keyframe-mode pacing — 1 ACK per frame). No PTS-based pacing
 *      pause here — we want the server's *unthrottled* delivery rate.
 *   4. Observe frames for RUN_SECONDS seconds. Record for each:
 *      arrivalWallMs (since first frame), ptsUnixSec, seq.
 *   5. Compute summary statistics: inter-arrival quantiles, total PTS
 *      span vs wall span (effective playback rate), and a windowed rate
 *      to detect initial burst vs steady-state.
 *
 * What the output tells us:
 *   - If mean effective rate ≈ 8x: server can sustain 8x; the app bug is
 *     pacing/display-layer; we can chase that confidently.
 *   - If mean effective rate << 8x (e.g. 1x-2x): server is the limiter;
 *     client can't deliver smooth 8x regardless of display strategy.
 *   - If initial window is high (burst) and steady-state is low: server
 *     has a local buffer, then falls back to disk-read rate.
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

/** How long to observe keyframe delivery after entering keyframe mode. */
const RUN_SECONDS = 30;
/** Max wall-clock for the whole probe (login + open + observation). */
const WATCHDOG_MS = (RUN_SECONDS + 30) * 1000;
/**
 * Which stream index to open. 0 = original recording (what single-cam Recorded
 * now uses — 4K H.265 on these cameras); 1 = transcoded-for-wasm (704x480 H.264);
 * 2 = sub. Override via PROBE_STREAM_INDEX.
 */
const STREAM_INDEX = Number(process.env.PROBE_STREAM_INDEX ?? 0);

interface FrameRecord {
  /** Wall-clock ms since the first observed frame (which is t=0). */
  arrivalWallMs: number;
  /** Absolute PTS in unix seconds. */
  ptsUnixSec: number;
  /** Server-assigned frame index (SHFL seq). */
  seq: number;
  /** Frame type: 0 = normal, 4 = post-restart resync keyframe. */
  frameType: number;
  /** Whether this frame's SHFL isKeyFrame flag is set. */
  isKeyFrame: boolean;
  /** SHFL payload (video bytes) size — used to compute effective throughput. */
  payloadBytes: number;
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

  const range = defaultPlaybackRange(creds);
  console.log(
    `playback range: ${unixToUtcTimeStr(range.start)} .. ${unixToUtcTimeStr(range.end)}`,
  );

  const taskId = generateTaskId();
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  const frames: FrameRecord[] = [];
  let firstFrameWall: number | null = null;
  let observationStartedAt: number | null = null;
  let ackCount = 0;
  let enteredKeyframeMode = false;

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  ws.on("open", () => {
    // Wait for create_connection#response before sending open — the NVR
    // sometimes drops opens that race the ack.
  });

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
      // Video frame types the app accepts.
      if (
        (shfl.frameType === 0 || shfl.frameType === 4) &&
        shfl.payload.byteLength > 0
      ) {
        const nowWall = Date.now();
        if (firstFrameWall === null) {
          firstFrameWall = nowWall;
          observationStartedAt = nowWall;
        }
        const ptsRaw = shfl.timestampLow + shfl.timestampHigh * 0x100000000;
        const ptsUnix = ptsToUnixSec(ptsRaw);
        frames.push({
          arrivalWallMs: nowWall - firstFrameWall,
          ptsUnixSec: ptsUnix,
          seq: shfl.seq,
          frameType: shfl.frameType,
          isKeyFrame: !!shfl.isKeyFrame,
          payloadBytes: shfl.payload.byteLength,
        });
        const ordinal = frames.length;
        const wallS = ((nowWall - firstFrameWall) / 1000).toFixed(2);
        // Print first few frames + every 10th to see cadence without spamming.
        if (ordinal <= 5 || ordinal % 10 === 0) {
          console.log(
            `[${wallS}s] #${ordinal} seq=${shfl.seq} ft=${shfl.frameType} key=${shfl.isKeyFrame ? 1 : 0} pts=${ptsUnix.toFixed(3)}`,
          );
        }
        // ACK every frame — keyframe mode ACKs per-frame, not per-N.
        if (shfl.seq > 0) {
          sendAck(shfl.seq);
          ackCount++;
        }

        if (observationStartedAt !== null && nowWall - observationStartedAt >= RUN_SECONDS * 1000) {
          resolveDone();
        }
      }
    } catch {
      // malformed frame — skip
    }
  });

  function handleText(text: string): void {
    let msg: { url?: string; basic?: { code?: number; msg?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.url?.endsWith("create_connection#response")) {
      // Match the app's PlaybackConnection.open(): send open, key_frame,
      // and audio/close back-to-back without waiting for responses. The
      // server relies on this ordering — if we wait for open#response
      // first, it sometimes delivers one all-frame frame before key_frame
      // takes effect and then stalls waiting for an ACK that doesn't
      // match the keyframe-mode index sequence.
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
      enteredKeyframeMode = true;
      console.log(`sent open+key_frame+audio/close; observing for ${RUN_SECONDS}s`);
      return;
    }
    if (msg.url === "/device/playback/open#response") {
      if (msg.basic?.code && msg.basic.code !== 0) {
        console.error(`playback/open rejected: code=${msg.basic.code} msg=${msg.basic.msg}`);
        resolveDone();
      }
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

  // Send playback/close + WS close so the session slot is released.
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

  // --- Analyze ---
  if (frames.length < 2) {
    console.error(`only ${frames.length} frames received — insufficient data`);
    writeResult("09-playback-keyframe-rate", {
      enteredKeyframeMode,
      frameCount: frames.length,
      frames,
      verdict: "INSUFFICIENT_DATA",
    });
    process.exit(frames.length === 0 ? 1 : 0);
  }

  // Inter-arrival gaps (ms).
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    gaps.push(frames[i].arrivalWallMs - frames[i - 1].arrivalWallMs);
  }
  const gapsSorted = [...gaps].sort((a, b) => a - b);

  // PTS-per-wall rates (effective playback speed) over 1-second windows.
  const windowMs = 1000;
  const windows: { tSec: number; ptsDeltaSec: number; framesInWindow: number }[] = [];
  const lastWallMs = frames[frames.length - 1].arrivalWallMs;
  for (let t = 0; t + windowMs <= lastWallMs; t += windowMs) {
    const inWindow = frames.filter(
      (f) => f.arrivalWallMs >= t && f.arrivalWallMs < t + windowMs,
    );
    if (inWindow.length < 2) continue;
    const ptsDelta = inWindow[inWindow.length - 1].ptsUnixSec - inWindow[0].ptsUnixSec;
    windows.push({
      tSec: t / 1000,
      ptsDeltaSec: ptsDelta,
      framesInWindow: inWindow.length,
    });
  }

  // Overall effective rate: total PTS span / total wall span.
  const totalPtsSpan = frames[frames.length - 1].ptsUnixSec - frames[0].ptsUnixSec;
  const totalWallSec = frames[frames.length - 1].arrivalWallMs / 1000;
  const effectiveRate = totalWallSec > 0 ? totalPtsSpan / totalWallSec : 0;

  // PTS gaps (should equal GOP ≈ 5s consistently if server is honoring
  // keyframe mode).
  const ptsGaps: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    ptsGaps.push(frames[i].ptsUnixSec - frames[i - 1].ptsUnixSec);
  }
  const ptsGapsSorted = [...ptsGaps].sort((a, b) => a - b);

  const totalBytes = frames.reduce((s, f) => s + f.payloadBytes, 0);
  const meanPayloadKB = frames.length > 0 ? totalBytes / frames.length / 1024 : 0;
  const throughputMbps = totalWallSec > 0 ? (totalBytes * 8) / (totalWallSec * 1_000_000) : 0;

  const summary = {
    enteredKeyframeMode,
    streamIndex: STREAM_INDEX,
    frameCount: frames.length,
    ackCount,
    observationWallSec: Number(totalWallSec.toFixed(2)),
    totalPtsSpanSec: Number(totalPtsSpan.toFixed(2)),
    effectiveRateX: Number(effectiveRate.toFixed(2)),
    meanKeyframePayloadKB: Number(meanPayloadKB.toFixed(1)),
    throughputMbps: Number(throughputMbps.toFixed(2)),
    interArrivalGapsMs: {
      p50: quantile(gapsSorted, 0.5),
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
    firstSecondRateX: windows.length > 0 ? Number(windows[0].ptsDeltaSec.toFixed(2)) : null,
    steadyStateRateX: windows.length > 3
      ? Number(
          (
            windows.slice(3).reduce((s, w) => s + w.ptsDeltaSec, 0) /
            Math.max(1, windows.length - 3)
          ).toFixed(2),
        )
      : null,
    windowsPerSecond: windows,
    frames,
  };

  const verdict =
    effectiveRate >= 7.5
      ? `Server sustains ~8x (${effectiveRate.toFixed(2)}x effective). Client-side is the limiter for smooth 8x.`
      : effectiveRate >= 3
        ? `Server sustains ~${effectiveRate.toFixed(1)}x; below the 8x target. Smooth 8x not achievable without server changes.`
        : `Server delivery is ~${effectiveRate.toFixed(1)}x — server is the bottleneck for keyframe mode playback.`;

  console.log(`\n=== summary (stream_index=${STREAM_INDEX}) ===`);
  console.log(`frames: ${frames.length}`);
  console.log(`observation: ${totalWallSec.toFixed(2)}s wall → ${totalPtsSpan.toFixed(2)}s PTS`);
  console.log(`effective rate: ${effectiveRate.toFixed(2)}x`);
  console.log(`keyframe size: ${meanPayloadKB.toFixed(0)} KB avg · throughput: ${throughputMbps.toFixed(2)} Mbit/s`);
  console.log(`inter-arrival gap (ms): p50=${summary.interArrivalGapsMs.p50} p95=${summary.interArrivalGapsMs.p95} min=${summary.interArrivalGapsMs.min} max=${summary.interArrivalGapsMs.max}`);
  console.log(`PTS gap (sec): p50=${summary.ptsGapsSec.p50} p95=${summary.ptsGapsSec.p95} min=${summary.ptsGapsSec.min} max=${summary.ptsGapsSec.max}`);
  console.log(`first 1s rate: ${summary.firstSecondRateX}x, steady-state (after 3s): ${summary.steadyStateRateX}x`);
  console.log(`\n${verdict}`);

  writeResult("09-playback-keyframe-rate", { ...summary, verdict });
}

runProbe().catch((err) => {
  console.error(err);
  process.exit(1);
});
