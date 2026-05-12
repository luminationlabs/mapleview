/**
 * Probe 16 — all-frame mode effective rate vs ACK gap.
 *
 * Probe 10 characterized keyframe-mode delivery: `rate = 3 × GOP /
 * ACK_gap_sec`. We never did the same measurement for all-frame mode,
 * so `ACK_GAP_MS_AT_1X = 100ms` in the client is a guess rather than a
 * matched value. That mismatch is the likely source of the 1x
 * oscillation: at 100ms ACK gap the server appears to deliver at
 * ~1.3–2x real time (docs/playback-pacing-log.md), buffer fills to
 * `PACING_LEAD_MS = 5000`, ACK pause fires, 2.5s freeze, resume,
 * repeat. Getting the ACK rate right up-front would make the pacing
 * pause a rare safety net rather than a steady-state mechanism.
 *
 * The probe opens ONE all-frame playback at 1x, sweeps ACK gaps
 * sequentially on the same session, and measures effective rate
 * (PTS-advance per wall-second) at each gap. Only one connection at a
 * time is open so this doesn't stress the NVR — total server footprint
 * is similar to a single background tab.
 *
 * For each ACK_GAP_MS value:
 *   1. Set the target ACK gap.
 *   2. Let the server settle for `SETTLE_SEC` at the new gap (flow
 *      control reacts to cadence changes over the next few ACKs).
 *   3. Observe for `MEASURE_SEC`, recording first/last PTS + wall.
 *   4. Effective rate = (lastPts - firstPts) / (lastWall - firstWall).
 *
 * Output summary:
 *   - rate per gap
 *   - the gap whose measured rate is closest to 1.0x
 *   - the observed GOP (captured incidentally from keyframe PTS deltas)
 *
 * Channel selection: first online by default. Override with
 *   PROBE_CHANNEL_ID='{00000001-0000-0000-0000-000000000000}'
 * to test the odd-model camera separately.
 *
 * Runtime budget: 8 gaps × (SETTLE + MEASURE) = 8 × (3 + 10) = 104s of
 * observation + ~10s setup. Hard watchdog at 180s cleans up on overrun.
 */
import WebSocket from "ws";
import {
  loadCredentials,
  login as probeLogin,
  listOnlineChannels,
  sleep,
  writeResult,
  defaultPlaybackRange,
  type NvrSession,
} from "./harness";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL } from "../../shfl";

const FLOW_CONTROL_INTERVAL = 8;
/** Sweep values (ms). 100 = current client value; higher = slower ACK. */
const GAP_SWEEP_MS: number[] = (() => {
  const env = process.env.PROBE_GAPS;
  if (env) return env.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  return [100, 160, 200, 250, 320, 400, 500, 700];
})();
/** How long to let the server adapt to a new ACK gap before measuring. */
const SETTLE_SEC = Number(process.env.PROBE_SETTLE_SEC ?? 3);
/** Measurement window per gap. Longer = more stable rate estimate. */
const MEASURE_SEC = Number(process.env.PROBE_MEASURE_SEC ?? 10);
/** Hard per-probe overrun. Shutdown handler runs first. */
const WATCHDOG_MS = 30_000 + GAP_SWEEP_MS.length * (SETTLE_SEC + MEASURE_SEC) * 1000;
/** First-keyframe bail so a wedged stream doesn't eat the whole budget. */
const FIRST_KF_TIMEOUT_MS = 20_000;
const LOGIN_HARD_TIMEOUT_MS = 15_000;
const POST_LOGIN_SETTLE_MS = 500;
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

/** Cleanup registry mirrors the one in probes 14/15: any forcible exit
 *  sends /device/playback/close before killing the socket so the NVR
 *  doesn't accumulate orphan tasks (which observationally can wedge
 *  /reqLogin on this device). */
interface OpenStreamEntry {
  ws: WebSocket;
  taskIdRef: { current: string };
  label: string;
}
class CleanupRegistry {
  private readonly streams = new Map<string, OpenStreamEntry>();
  private shuttingDown = false;
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }
  register(key: string, entry: OpenStreamEntry): void {
    this.streams.set(key, entry);
  }
  unregister(key: string): void {
    this.streams.delete(key);
  }
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const entries = [...this.streams.values()];
    if (entries.length === 0) return;
    console.error(`[cleanup] ${reason}: closing ${entries.length} open streams`);
    for (const { ws, taskIdRef, label } of entries) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              url: "/device/playback/close",
              basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
              data: { task_id: taskIdRef.current },
            }),
          );
        }
      } catch (err) {
        console.error(`[cleanup] ${label}: send close failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    await sleep(250);
    for (const { ws, label } of entries) {
      try {
        ws.close();
      } catch (err) {
        console.error(`[cleanup] ${label}: ws.close failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    await sleep(250);
  }
}

const cleanupRegistry = new CleanupRegistry();

function installShutdownHandlers(): void {
  const run = async (reason: string, code: number) => {
    try {
      await Promise.race([
        cleanupRegistry.shutdown(reason),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => void run("SIGINT", 130));
  process.on("SIGTERM", () => void run("SIGTERM", 143));
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException:", err);
    void run("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection:", err);
    void run("unhandledRejection", 1);
  });
}

function installHardWatchdog(ms: number): NodeJS.Timeout {
  return setTimeout(() => {
    console.error(`\n[watchdog] ${ms}ms elapsed — cleaning up and exiting`);
    void cleanupRegistry.shutdown("watchdog").finally(() => process.exit(2));
  }, ms).unref();
}

async function loginWithTimeout(
  creds: Parameters<typeof probeLogin>[0],
  timeoutMs: number,
  label: string,
): Promise<NvrSession> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      probeLogin(creds),
      new Promise<NvrSession>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} login timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface GapMeasurement {
  gapMs: number;
  firstPtsUnix: number | null;
  lastPtsUnix: number | null;
  firstWallMs: number | null;
  lastWallMs: number | null;
  frameCount: number;
  keyframeCount: number;
  ackCount: number;
  effectiveRate: number | null;
  notes: string | null;
}

async function main() {
  installShutdownHandlers();
  installHardWatchdog(WATCHDOG_MS);
  console.log(
    `config: gaps=[${GAP_SWEEP_MS.join(",")}] settleSec=${SETTLE_SEC} measureSec=${MEASURE_SEC}`,
  );

  const creds = loadCredentials();
  let session: NvrSession;
  try {
    session = await loginWithTimeout(creds, LOGIN_HARD_TIMEOUT_MS, "primary");
  } catch (err) {
    console.error(`primary login failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  console.log(`login ok in ${session.loginMs}ms (sessionId=${session.sessionId.slice(0, 8)})`);
  await sleep(POST_LOGIN_SETTLE_MS);

  const channelId = await (async () => {
    const env = process.env.PROBE_CHANNEL_ID;
    if (env && env.length > 0) return env;
    const online = await listOnlineChannels(session);
    if (online.length === 0) throw new Error("no online channels");
    return online[0];
  })();
  const range = defaultPlaybackRange(creds);
  console.log(
    `channel=${channelId.slice(1, 9)} range=${range.start}..${range.end} ` +
      `(${unixToUtcTimeStr(range.start)} .. ${unixToUtcTimeStr(range.end)})`,
  );

  const taskIdRef = { current: generateTaskId() };
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  cleanupRegistry.register("probe-16", { ws, taskIdRef, label: "probe-16" });

  let lastSeq = 0;
  let lastSentIndex = 0;
  let gapState: GapMeasurement | null = null;
  /** Keyframe PTS history for incidental GOP measurement. */
  let prevKeyframePts: number | null = null;
  const keyframeDeltas: number[] = [];

  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => (resolveReady = r));
  let readyTimer: NodeJS.Timeout | null = setTimeout(() => {
    readyTimer = null;
    console.error(`first keyframe timeout after ${FIRST_KF_TIMEOUT_MS}ms`);
    void cleanupRegistry.shutdown("first-kf-timeout").finally(() => process.exit(3));
  }, FIRST_KF_TIMEOUT_MS);

  ws.on("unexpected-response", (_req, res) => {
    console.error(`upgrade HTTP ${res.statusCode}`);
    try {
      res.resume();
    } catch {
      /* best-effort */
    }
    void cleanupRegistry.shutdown("unexpected-response").finally(() => process.exit(4));
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = typeof data === "string" ? data : data.toString("utf-8");
      handleText(text);
      return;
    }
    try {
      let chunk: Uint8Array;
      if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
      else if (Buffer.isBuffer(data)) chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (Array.isArray(data)) chunk = new Uint8Array(Buffer.concat(data));
      else return;

      const wsFrame = parseWSFrame(chunk);
      const frameTaskId = (wsFrame.header.data as { task_id?: string })?.task_id;
      if (frameTaskId && frameTaskId !== taskIdRef.current) return;
      const shfl = parseSHFL(wsFrame.payload);
      if (!(shfl.frameType === 0 || shfl.frameType === 4)) return;
      if (shfl.payload.byteLength === 0) return;

      const nowMs = Date.now();
      const ptsRaw = shfl.timestampLow + shfl.timestampHigh * 0x100000000;
      const ptsUnix = ptsToUnixSec(ptsRaw);

      if (shfl.isKeyFrame) {
        if (prevKeyframePts !== null) {
          const delta = (ptsRaw - prevKeyframePts) / 10_000_000;
          if (delta > 0.1 && delta < 30) keyframeDeltas.push(delta);
        }
        prevKeyframePts = ptsRaw;
      }

      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
        resolveReady();
      }

      if (gapState !== null) {
        if (gapState.firstPtsUnix === null) {
          gapState.firstPtsUnix = ptsUnix;
          gapState.firstWallMs = nowMs;
        }
        gapState.lastPtsUnix = ptsUnix;
        gapState.lastWallMs = nowMs;
        gapState.frameCount++;
        if (shfl.isKeyFrame) gapState.keyframeCount++;
      }

      if (shfl.seq > 0) lastSeq = shfl.seq;
    } catch {
      // skip malformed frame
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
      ws.send(
        JSON.stringify({
          url: "/device/playback/open",
          basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
          data: {
            task_id: taskIdRef.current,
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
          url: "/device/playback/all_frame",
          basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
          data: {
            task_id: taskIdRef.current,
            frame_time: unixToUtcTimeStr(range.start),
          },
        }),
      );
      ws.send(
        JSON.stringify({
          url: "/device/playback/audio/close",
          basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
          data: { task_id: taskIdRef.current },
        }),
      );
      return;
    }
    if (msg.url === "/device/playback/open#response") {
      const code = msg.basic?.code;
      if (typeof code === "number" && code !== 0) {
        console.error(`playback/open code=${code} msg=${msg.basic?.msg ?? ""}`);
        void cleanupRegistry.shutdown("open-rejected").finally(() => process.exit(5));
      }
    }
  }

  /** Start an ACK-pacing timer at the given gap. Returns a cancel fn. */
  function startAcking(gapMs: number): () => void {
    let timer: NodeJS.Timeout | null = null;
    const tick = () => {
      if (ws.readyState === WebSocket.OPEN && lastSeq > lastSentIndex) {
        // Mirror the client: ACK index must be seq % 8 in all-frame mode.
        const nextIdx = lastSeq - (lastSeq % FLOW_CONTROL_INTERVAL);
        if (nextIdx > lastSentIndex) {
          lastSentIndex = nextIdx;
          ws.send(
            JSON.stringify({
              url: "/device/playback/refresh_play_index",
              basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
              data: { task_id: taskIdRef.current, play_frame_index: nextIdx },
            }),
          );
          if (gapState !== null) gapState.ackCount++;
        }
      }
      timer = setTimeout(tick, gapMs);
    };
    timer = setTimeout(tick, gapMs);
    return () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }

  let sweepComplete = false;
  ws.on("close", () => {
    if (!sweepComplete && !cleanupRegistry.isShuttingDown()) {
      console.error("ws closed unexpectedly");
      process.exit(6);
    }
  });

  await ready;
  console.log(`first frame received. Starting sweep.`);

  const measurements: GapMeasurement[] = [];
  let cancelAck: (() => void) | null = null;

  try {
    for (const gapMs of GAP_SWEEP_MS) {
      if (cancelAck) cancelAck();
      cancelAck = startAcking(gapMs);
      console.log(`\n[gap=${gapMs}ms] settling ${SETTLE_SEC}s...`);
      await sleep(SETTLE_SEC * 1000);
      gapState = {
        gapMs,
        firstPtsUnix: null,
        lastPtsUnix: null,
        firstWallMs: null,
        lastWallMs: null,
        frameCount: 0,
        keyframeCount: 0,
        ackCount: 0,
        effectiveRate: null,
        notes: null,
      };
      console.log(`[gap=${gapMs}ms] measuring ${MEASURE_SEC}s...`);
      await sleep(MEASURE_SEC * 1000);
      const m = gapState;
      gapState = null;
      if (
        m.firstPtsUnix !== null &&
        m.lastPtsUnix !== null &&
        m.firstWallMs !== null &&
        m.lastWallMs !== null
      ) {
        const ptsDelta = m.lastPtsUnix - m.firstPtsUnix;
        const wallDeltaSec = (m.lastWallMs - m.firstWallMs) / 1000;
        m.effectiveRate = wallDeltaSec > 0 ? ptsDelta / wallDeltaSec : null;
      } else {
        m.notes = "no frames during measurement window";
      }
      console.log(
        `[gap=${gapMs}ms] rate=${m.effectiveRate === null ? "—" : m.effectiveRate.toFixed(3) + "x"} ` +
          `frames=${m.frameCount} kfs=${m.keyframeCount} acks=${m.ackCount}`,
      );
      measurements.push(m);
    }
  } finally {
    if (cancelAck) cancelAck();
  }

  sweepComplete = true;
  // Graceful close.
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          url: "/device/playback/close",
          basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
          data: { task_id: taskIdRef.current },
        }),
      );
    }
    ws.close();
  } catch {
    /* best-effort */
  }
  cleanupRegistry.unregister("probe-16");
  await sleep(200);

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const gopSecEstimate = median(keyframeDeltas);
  const rated = measurements.filter((m) => m.effectiveRate !== null);
  const closestTo1x = rated.reduce<GapMeasurement | null>((best, m) => {
    if (best === null) return m;
    const bestErr = Math.abs((best.effectiveRate ?? 0) - 1);
    const mErr = Math.abs((m.effectiveRate ?? 0) - 1);
    return mErr < bestErr ? m : best;
  }, null);

  console.log(`\n=== summary ===`);
  console.log(`channel=${channelId.slice(1, 9)}`);
  console.log(`observed GOP (median keyframe delta): ${gopSecEstimate?.toFixed(3) ?? "—"}s`);
  console.log(`per-gap rates:`);
  for (const m of measurements) {
    const rateStr = m.effectiveRate === null ? "—" : m.effectiveRate.toFixed(3) + "x";
    console.log(`  ${String(m.gapMs).padStart(4)}ms  →  ${rateStr}  (frames=${m.frameCount})`);
  }
  if (closestTo1x !== null) {
    console.log(
      `\nACK gap closest to 1.0x delivery: ${closestTo1x.gapMs}ms ` +
        `(measured ${closestTo1x.effectiveRate!.toFixed(3)}x)`,
    );
  }

  writeResult("16-all-frame-ack-rate", {
    channelId,
    observedGopSec: gopSecEstimate,
    measurements,
    closestTo1xGapMs: closestTo1x?.gapMs ?? null,
  });
}

main().catch((err) => {
  console.error(err);
  void cleanupRegistry.shutdown("main threw").finally(() => process.exit(1));
});
