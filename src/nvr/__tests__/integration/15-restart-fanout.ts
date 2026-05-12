/**
 * Probe 15 — restart-cycle fan-out: does a simultaneous `seekAll` across N
 * channels produce post-restart first-keyframe latencies above the app's
 * 5s LOADING_WATCHDOG_MS?
 *
 * Probe 14 ruled out cold-open fan-out as the root cause of the stuck /
 * recover / stuck cascade the user sees in the Recorded tab. The remaining
 * suspect is the *restart* path: `seekAll` (or equivalent) synchronously
 * iterates every channel's `PlaybackConnection`, calls `restart()`, which
 * sends `/device/playback/close` (old task_id) → `/device/playback/open`
 * (new task_id, new start_time) → `all_frame` back-to-back on the same WS.
 *
 * What this probe measures on the real NVR:
 *
 * (a) **Post-restart first-keyframe latency.** From the moment we write
 *     the three-command restart burst to the WS, how long until an IDR
 *     tagged with the NEW task_id arrives? Any stream exceeding 5000ms
 *     would watchdog-fire in the app.
 *
 * (b) **Stragglers from the old task.** Probe records the count and PTS
 *     range of frames still carrying the pre-restart task_id after the
 *     close was sent. Tells us whether the `seekDropActive` gate has
 *     real work to do.
 *
 * (c) **Server fairness during concurrent restarts.** N simultaneous
 *     restarts force the NVR to close N tasks + open N new tasks at once.
 *     If its scheduler serializes these, some streams get a prompt new-task
 *     IDR and others wait — the "stuck / recover / stuck" cascade would
 *     match that pattern.
 *
 * (d) **Userpaused-style no-ACK streams.** Recorded single-cam pauses all
 *     background channels (`pauseAllExcept`). A scrub still restarts them,
 *     but their post-restart path doesn't send ACKs. An env-var
 *     `PROBE_PAUSED_COUNT` makes K of the N streams stop ACKing after the
 *     restart, so we can see whether that starves the ACKing streams (the
 *     single-cam active channel) via server-side resource contention.
 *
 * Protocol per stream:
 *   1. Open and reach first keyframe (same as probe 14).
 *   2. Hold for STEADY_SECONDS at 1x all-frame, ACKing on seq % 8.
 *   3. Simultaneously across all streams: rotate task_id, send
 *      /device/playback/close (OLD task_id) + /device/playback/open (NEW
 *      task_id, start_time = original_start + SEEK_FORWARD_SEC) +
 *      /device/playback/all_frame (NEW task_id).
 *   4. From that moment on, filter inbound frames by task_id — only
 *      frames tagged with NEW task_id count toward steady-state. Count
 *      stragglers (OLD task_id) for diagnostic output.
 *   5. If this stream is in the "paused" subset, stop ACKing after
 *      restart. Otherwise keep ACKing on seq % 8 as before.
 *   6. Observe for OBSERVE_SECONDS after the restart.
 *
 * Summary output:
 *   - firstKeyframePreRestartMs (for context; should match probe 14)
 *   - postRestartFirstKeyframeMs per stream (THE number we care about)
 *   - stragglerCount per stream (frames still on OLD task_id post-close)
 *   - maxInterKeyframeGapPostRestartMs per stream
 *   - Verdict: which streams (if any) would watchdog-fire
 *
 * The probe shares the hardening pattern established in probe 14:
 * CleanupRegistry for graceful exit, wrapped logins with hard timeout,
 * fanout-scaled watchdog.
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

const MAX_STREAMS_PER_SESSION = 6;
const FLOW_CONTROL_INTERVAL = 8;
const LOADING_WATCHDOG_MS = 5000;
const FANOUT_N = Number(process.env.PROBE_FANOUT_N ?? 8);
/** Number of streams that STOP ACKing after restart (mirrors pauseAllExcept). */
const PAUSED_COUNT = Math.min(
  FANOUT_N,
  Number(process.env.PROBE_PAUSED_COUNT ?? Math.max(0, FANOUT_N - 1)),
);
/** How long each stream streams normally before the restart burst fires. */
const STEADY_SECONDS = Number(process.env.PROBE_STEADY_SECONDS ?? 3);
/** Post-restart observation window. */
const OBSERVE_SECONDS = Number(process.env.PROBE_OBSERVE_SECONDS ?? 30);
/** How far forward the restart seeks. Must be within the playback range. */
const SEEK_FORWARD_SEC = Number(process.env.PROBE_SEEK_FORWARD_SEC ?? 60);
const FIRST_KF_TIMEOUT_MS = 15_000;
const POST_RESTART_FIRST_KF_TIMEOUT_MS = 20_000;
const POST_LOGIN_SETTLE_MS = 500;
const LOGIN_HARD_TIMEOUT_MS = 15_000;
const WATCHDOG_MS =
  LOGIN_HARD_TIMEOUT_MS +
  Math.ceil(FANOUT_N / MAX_STREAMS_PER_SESSION) * LOGIN_HARD_TIMEOUT_MS +
  FIRST_KF_TIMEOUT_MS +
  STEADY_SECONDS * 1000 +
  POST_RESTART_FIRST_KF_TIMEOUT_MS +
  OBSERVE_SECONDS * 1000 +
  30_000;

const FILETIME_UNIX_OFFSET_SEC = 11644473600;

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

interface PoolSession {
  session: NvrSession;
  claims: number;
}
class SessionPool {
  private readonly sessions: PoolSession[] = [];
  private pendingLogin: Promise<NvrSession | null> | null = null;
  private extraSessionCounter = 0;
  readonly loginTimings: { label: string; durationMs: number; sessionId: string }[] = [];
  constructor(
    primary: NvrSession,
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
  ) {
    this.sessions.push({ session: primary, claims: 0 });
  }
  async acquire(label: string): Promise<NvrSession> {
    for (let iter = 0; iter < 20; iter++) {
      for (const s of this.sessions) {
        if (s.claims < MAX_STREAMS_PER_SESSION) {
          s.claims++;
          return s.session;
        }
      }
      if (this.pendingLogin) {
        await this.pendingLogin;
        continue;
      }
      this.extraSessionCounter++;
      const extraLabel = `extra-${this.extraSessionCounter}`;
      const startedAt = Date.now();
      console.log(`[pool] ${label}: all ${this.sessions.length} sessions full — starting ${extraLabel}`);
      this.pendingLogin = loginWithTimeout(
        { host: this.host, username: this.username, password: this.password },
        LOGIN_HARD_TIMEOUT_MS,
        extraLabel,
      )
        .then((fresh) => {
          const dur = Date.now() - startedAt;
          this.loginTimings.push({ label: extraLabel, durationMs: dur, sessionId: fresh.sessionId });
          this.sessions.push({ session: fresh, claims: 0 });
          console.log(`[pool] ${extraLabel} ready in ${dur}ms (total=${this.sessions.length})`);
          return fresh;
        })
        .catch((err) => {
          console.error(`[pool] ${extraLabel} failed: ${err instanceof Error ? err.message : err}`);
          return null;
        })
        .finally(() => {
          this.pendingLogin = null;
        });
      await this.pendingLogin;
    }
    throw new Error("SessionPool.acquire: exhausted retries");
  }
}

/** Per-stream state. Exposes just enough for main() to schedule the restart
 *  burst and drive the post-restart observation window. */
interface StreamRunner {
  label: string;
  channelId: string;
  paused: boolean;
  result: StreamTiming;
  ws: WebSocket;
  taskIdRef: { current: string };
  /** Resolves once the first pre-restart keyframe arrives. */
  preRestartReady: Promise<void>;
  /** Call to send the restart burst. Returns once the three commands are on the
   *  wire. Caller coordinates so all streams' restart lands within one tick. */
  triggerRestart: (newStartUnix: number) => void;
  /** Resolves once the observation window ends (either via post-restart
   *  OBSERVE_SECONDS elapsing, first-kf timeout, or WS close). */
  done: Promise<void>;
}

interface StreamTiming {
  label: string;
  channelId: string;
  sessionIdShort: string;
  paused: boolean;
  /** Time from open-request to first pre-restart keyframe. */
  firstKeyframePreRestartMs: number | null;
  /** Wall timestamp when the restart burst was sent. */
  restartSentAtMs: number | null;
  /** Wall ms from restart sent → first keyframe tagged with NEW task_id. */
  postRestartFirstKeyframeMs: number | null;
  /** Count of video frames carrying OLD task_id after restart was sent. */
  stragglerFrameCount: number;
  /** Max inter-keyframe gap during the post-restart observation window. */
  maxInterKeyframeGapPostRestartMs: number;
  /** Post-restart keyframe count (new task_id only). */
  postRestartKeyframeCount: number;
  /** Non-fatal issue descriptor. */
  error: string | null;
}

async function startStream(
  pool: SessionPool,
  label: string,
  channelId: string,
  initialRange: { start: number; end: number },
  paused: boolean,
): Promise<StreamRunner> {
  const result: StreamTiming = {
    label,
    channelId,
    sessionIdShort: "",
    paused,
    firstKeyframePreRestartMs: null,
    restartSentAtMs: null,
    postRestartFirstKeyframeMs: null,
    stragglerFrameCount: 0,
    maxInterKeyframeGapPostRestartMs: 0,
    postRestartKeyframeCount: 0,
    error: null,
  };

  const session = await pool.acquire(label);
  result.sessionIdShort = session.sessionId.slice(0, 8);

  const taskIdRef = { current: generateTaskId() };
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  cleanupRegistry.register(label, { ws, taskIdRef, label });

  const openRequestedAtMs = Date.now();

  let restartActive = false;
  let postRestartKeyframeWall: number | null = null;

  let resolvePreRestart: () => void = () => {};
  const preRestartReady = new Promise<void>((r) => (resolvePreRestart = r));
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));

  const preRestartKfTimer = setTimeout(() => {
    if (result.firstKeyframePreRestartMs === null) {
      result.error = `pre-restart first-kf timeout after ${FIRST_KF_TIMEOUT_MS}ms`;
      resolvePreRestart();
      resolveDone();
    }
  }, FIRST_KF_TIMEOUT_MS);

  let postRestartKfTimer: NodeJS.Timeout | null = null;
  let observeTimer: NodeJS.Timeout | null = null;

  ws.on("unexpected-response", (_req, res) => {
    result.error = result.error ?? `upgrade HTTP ${res.statusCode}`;
    try {
      res.resume();
    } catch {
      /* best-effort */
    }
    resolvePreRestart();
    resolveDone();
  });

  ws.on("message", (data, isBinary) => {
    try {
      if (!isBinary) {
        const text = typeof data === "string" ? data : data.toString("utf-8");
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
      const wsFrame = parseWSFrame(chunk);
      const frameTaskId = (wsFrame.header.data as { task_id?: string })?.task_id;
      const shfl = parseSHFL(wsFrame.payload);
      if (!(shfl.frameType === 0 || shfl.frameType === 4)) return;
      if (shfl.payload.byteLength === 0) return;

      const nowMs = Date.now();

      if (restartActive) {
        // Old task_id frames arriving post-close are stragglers. Count them
        // for diagnostic output; they would bypass the app's seekDropActive
        // gate if the gate weren't set.
        if (frameTaskId && frameTaskId !== taskIdRef.current) {
          result.stragglerFrameCount++;
          return;
        }
        // New task_id frame arrived. Record the first keyframe.
        if (shfl.isKeyFrame) {
          if (result.postRestartFirstKeyframeMs === null) {
            result.postRestartFirstKeyframeMs = nowMs - (result.restartSentAtMs ?? nowMs);
            if (postRestartKfTimer) {
              clearTimeout(postRestartKfTimer);
              postRestartKfTimer = null;
            }
            observeTimer = setTimeout(() => {
              resolveDone();
            }, OBSERVE_SECONDS * 1000);
          } else if (postRestartKeyframeWall !== null) {
            const gap = nowMs - postRestartKeyframeWall;
            if (gap > result.maxInterKeyframeGapPostRestartMs) {
              result.maxInterKeyframeGapPostRestartMs = gap;
            }
          }
          result.postRestartKeyframeCount++;
          postRestartKeyframeWall = nowMs;
        }
      } else {
        // Pre-restart phase. Just wait for the first keyframe and keep ACKing.
        if (shfl.isKeyFrame && result.firstKeyframePreRestartMs === null) {
          result.firstKeyframePreRestartMs = nowMs - openRequestedAtMs;
          clearTimeout(preRestartKfTimer);
          resolvePreRestart();
        }
      }

      // ACK cadence: all-frame mode, seq % 8. Paused streams stop ACKing once
      // restart fires — that's the whole point of the paused variant.
      const shouldAck =
        shfl.seq > 0 &&
        shfl.seq % FLOW_CONTROL_INTERVAL === 0 &&
        !(paused && restartActive);
      if (shouldAck) sendAck(shfl.seq);
    } catch {
      // Malformed frame — skip.
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
      sendPlaybackOpen(initialRange.start);
      sendAllFrame(initialRange.start);
      sendAudioClose();
      return;
    }
    if (msg.url === "/device/playback/open#response") {
      const code = msg.basic?.code;
      if (typeof code === "number" && code !== 0) {
        result.error = result.error ?? `playback/open code=${code} msg=${msg.basic?.msg ?? ""}`;
        resolvePreRestart();
        resolveDone();
      }
    }
  }

  function sendPlaybackOpen(startUnix: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        url: "/device/playback/open",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskIdRef.current,
          channel_id: channelId,
          start_time: startUnix,
          end_time: initialRange.end,
          stream_index: 2,
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
  }

  function sendAllFrame(frameUnix: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        url: "/device/playback/all_frame",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskIdRef.current,
          frame_time: unixToUtcTimeStr(frameUnix),
        },
      }),
    );
  }

  function sendAudioClose(): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        url: "/device/playback/audio/close",
        basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskIdRef.current },
      }),
    );
  }

  function sendPlaybackClose(taskId: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        url: "/device/playback/close",
        basic: { ver: "1.0", id: 2, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId },
      }),
    );
  }

  function sendAck(seq: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        url: "/device/playback/refresh_play_index",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskIdRef.current, play_frame_index: seq },
      }),
    );
  }

  function triggerRestart(newStartUnix: number): void {
    if (restartActive) return;
    const oldTaskId = taskIdRef.current;
    const newTaskId = generateTaskId();
    taskIdRef.current = newTaskId;
    restartActive = true;
    result.restartSentAtMs = Date.now();
    // Match PlaybackConnection.restart()'s wire order: close old task → open
    // new task → all_frame → audio/close.
    sendPlaybackClose(oldTaskId);
    sendPlaybackOpen(newStartUnix);
    sendAllFrame(newStartUnix);
    sendAudioClose();
    postRestartKfTimer = setTimeout(() => {
      if (result.postRestartFirstKeyframeMs === null) {
        result.error = result.error ?? `post-restart first-kf timeout after ${POST_RESTART_FIRST_KF_TIMEOUT_MS}ms`;
        resolveDone();
      }
    }, POST_RESTART_FIRST_KF_TIMEOUT_MS);
  }

  ws.on("close", () => {
    resolvePreRestart();
    resolveDone();
  });
  ws.on("error", () => {
    // surfaced via unexpected-response / close
  });

  // Clean up per-stream resources after observation ends. Register on `done`
  // so both happy path and early-exit paths run through here.
  void done.then(() => {
    clearTimeout(preRestartKfTimer);
    if (postRestartKfTimer) clearTimeout(postRestartKfTimer);
    if (observeTimer) clearTimeout(observeTimer);
    try {
      if (ws.readyState === WebSocket.OPEN) {
        sendPlaybackClose(taskIdRef.current);
      }
      ws.close();
    } catch {
      /* best-effort */
    }
    cleanupRegistry.unregister(label);
  });

  return {
    label,
    channelId,
    paused,
    result,
    ws,
    taskIdRef,
    preRestartReady,
    triggerRestart,
    done,
  };
}

async function pickChannels(session: NvrSession, want: number): Promise<string[]> {
  const online = await listOnlineChannels(session);
  if (online.length === 0) throw new Error("No online channels");
  const result: string[] = [];
  for (let i = 0; i < want; i++) result.push(online[i % online.length]);
  return result;
}

function bucket(values: number[], label: string): string {
  if (values.length === 0) return `${label}: (no data)`;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const max = sorted[sorted.length - 1];
  return `${label}: min=${min}ms p50=${p50}ms p90=${p90}ms max=${max}ms`;
}

async function main() {
  installShutdownHandlers();
  installHardWatchdog(WATCHDOG_MS);
  console.log(
    `config: fanoutN=${FANOUT_N} pausedCount=${PAUSED_COUNT} steadySec=${STEADY_SECONDS} ` +
      `observeSec=${OBSERVE_SECONDS} seekForwardSec=${SEEK_FORWARD_SEC} watchdogMs=${WATCHDOG_MS}`,
  );

  const creds = loadCredentials();
  let primary: NvrSession;
  try {
    primary = await loginWithTimeout(creds, LOGIN_HARD_TIMEOUT_MS, "primary");
  } catch (err) {
    console.error(`primary login failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  console.log(`primary login ok in ${primary.loginMs}ms (sessionId=${primary.sessionId.slice(0, 8)})`);
  await sleep(POST_LOGIN_SETTLE_MS);

  const channels = await pickChannels(primary, FANOUT_N);
  const range = defaultPlaybackRange(creds);
  // Make sure the seek forward lands inside the range. The harness default is
  // "now - 30 min .. now - 15 min" (15 min window); we only jump SEEK_FORWARD_SEC.
  console.log(
    `channels: ${channels.map((c) => c.slice(1, 9)).join(",")}, ` +
      `initialRange ${range.start}..${range.end}, seekTarget=${range.start + SEEK_FORWARD_SEC}`,
  );

  const pool = new SessionPool(primary, creds.host, creds.username, creds.password);

  // Open all N streams in parallel. Paused subset = last PAUSED_COUNT streams
  // (arbitrary — the subset choice doesn't matter for the hypothesis).
  const runners = await Promise.all(
    channels.map((channelId, i) =>
      startStream(pool, `stream-${i + 1}`, channelId, range, i >= FANOUT_N - PAUSED_COUNT),
    ),
  );

  // Wait until every stream has received its pre-restart first keyframe.
  console.log(`\nwaiting for all ${runners.length} streams to reach first keyframe...`);
  await Promise.all(runners.map((r) => r.preRestartReady));

  const preRestartReachedAtMs = Date.now();
  console.log(
    `all streams live. Holding steady for ${STEADY_SECONDS}s before restart burst.`,
  );
  await sleep(STEADY_SECONDS * 1000);

  // Fire the restart burst on every runner within one synchronous tick.
  // Matches the app's `seekAll` iterating channels and calling restart() on
  // each — no stagger, bump runs through all at once.
  console.log(`\n=== firing restart burst across ${runners.length} streams ===`);
  const restartWallMs = Date.now();
  for (const r of runners) {
    r.triggerRestart(range.start + SEEK_FORWARD_SEC);
  }

  // Wait for all streams to finish their post-restart observation window
  // (or their post-restart first-kf timeout, or WS close).
  await Promise.all(runners.map((r) => r.done));
  const endedAtMs = Date.now();

  const timings = runners.map((r) => r.result);

  console.log(`\n=== per-stream timings ===`);
  for (const t of timings) {
    const pre =
      t.firstKeyframePreRestartMs === null ? "—" : `${t.firstKeyframePreRestartMs}ms`;
    const post =
      t.postRestartFirstKeyframeMs === null
        ? t.error === null
          ? "no-kf-yet"
          : "—"
        : `${t.postRestartFirstKeyframeMs}ms`;
    const err = t.error ? ` ERROR=${t.error}` : "";
    console.log(
      `${t.label} ch=${t.channelId.slice(1, 9)} ${t.paused ? "PAUSED" : "acking"} ` +
        `preKf=${pre} postRestartKf=${post} stragglers=${t.stragglerFrameCount} ` +
        `postKfCount=${t.postRestartKeyframeCount} maxPostKfGap=${t.maxInterKeyframeGapPostRestartMs}ms${err}`,
    );
  }

  const postRestartFirstKf = timings
    .filter((t) => t.postRestartFirstKeyframeMs !== null)
    .map((t) => t.postRestartFirstKeyframeMs!);
  const maxPostKfGap = timings.map((t) => t.maxInterKeyframeGapPostRestartMs);
  const stragglers = timings.map((t) => t.stragglerFrameCount);
  const watchdogCrossings = timings.filter(
    (t) =>
      t.postRestartFirstKeyframeMs === null ||
      t.postRestartFirstKeyframeMs > LOADING_WATCHDOG_MS,
  );
  const steadyStateCrossings = timings.filter(
    (t) => t.maxInterKeyframeGapPostRestartMs > LOADING_WATCHDOG_MS,
  );

  console.log(`\n=== distributions ===`);
  console.log(bucket(postRestartFirstKf, "postRestartFirstKeyframeMs"));
  console.log(bucket(maxPostKfGap, "maxInterKeyframeGapPostRestartMs"));
  console.log(bucket(stragglers, "stragglerFrameCount"));

  const ackingStreams = timings.filter((t) => !t.paused);
  const pausedStreams = timings.filter((t) => t.paused);
  if (ackingStreams.length > 0 && pausedStreams.length > 0) {
    const ackingFirstKf = ackingStreams
      .filter((t) => t.postRestartFirstKeyframeMs !== null)
      .map((t) => t.postRestartFirstKeyframeMs!);
    const pausedFirstKf = pausedStreams
      .filter((t) => t.postRestartFirstKeyframeMs !== null)
      .map((t) => t.postRestartFirstKeyframeMs!);
    console.log(`\n=== acking vs paused ===`);
    console.log(bucket(ackingFirstKf, "  acking postRestartFirstKeyframeMs"));
    console.log(bucket(pausedFirstKf, "  paused postRestartFirstKeyframeMs"));
  }

  console.log(`\n=== watchdog crossings (LOADING_WATCHDOG_MS=${LOADING_WATCHDOG_MS}) ===`);
  console.log(
    `post-restart first-kf exceeded or never arrived: ${watchdogCrossings.length}/${timings.length}`,
  );
  console.log(
    `steady-state post-restart gap exceeded:          ${steadyStateCrossings.length}/${timings.length}`,
  );

  let verdict: string;
  if (watchdogCrossings.length === 0 && steadyStateCrossings.length === 0) {
    verdict =
      `All ${timings.length} streams reached their post-restart first keyframe within ${LOADING_WATCHDOG_MS}ms ` +
      `and held steady. Restart cascade is NOT reproduced by this protocol on a healthy NVR. ` +
      `Next candidate: the pre-buffer path in the client (setLoading(false) only fires on flushPreBuffer, ` +
      `which needs 2s-PTS or 4s-wall of buffered frames — under specific pacing conditions this is 5s+).`;
  } else if (watchdogCrossings.length > 0) {
    const paused = watchdogCrossings.filter((t) => t.paused).length;
    const acking = watchdogCrossings.length - paused;
    verdict =
      `${watchdogCrossings.length}/${timings.length} streams exceeded ${LOADING_WATCHDOG_MS}ms to first ` +
      `post-restart keyframe (${acking} acking, ${paused} paused). The restart burst IS reproducing the ` +
      `watchdog-reopen cascade. Compare straggler counts to see if stale-frame contamination ` +
      `is in play on this NVR. Plausible fixes: stagger seekAll's per-channel restarts, or mark paused ` +
      `connections as "don't set loading on restart" so background channels can't watchdog-fire.`;
  } else {
    verdict =
      `First-keyframe reached for all streams within threshold, but ${steadyStateCrossings.length} had ` +
      `a steady-state gap > ${LOADING_WATCHDOG_MS}ms. The server's post-restart delivery is unstable for ` +
      `some streams — dig into those channels' straggler counts and keyframe counts for patterns.`;
  }

  const summary = {
    params: {
      fanoutN: FANOUT_N,
      pausedCount: PAUSED_COUNT,
      steadySeconds: STEADY_SECONDS,
      observeSeconds: OBSERVE_SECONDS,
      seekForwardSec: SEEK_FORWARD_SEC,
      loadingWatchdogMs: LOADING_WATCHDOG_MS,
      maxStreamsPerSession: MAX_STREAMS_PER_SESSION,
      flowControlInterval: FLOW_CONTROL_INTERVAL,
      playbackRange: range,
    },
    totalWallMs: endedAtMs - preRestartReachedAtMs,
    poolLoginTimings: pool.loginTimings,
    restartBurstSentAtMs: restartWallMs,
    timings,
    watchdogCrossingsAtFirstKf: watchdogCrossings.length,
    steadyStateCrossings: steadyStateCrossings.length,
    verdict,
  };
  console.log(`\n=== verdict ===\n${verdict}`);
  writeResult("15-restart-fanout", summary);
}

main().catch((err) => {
  console.error(err);
  void cleanupRegistry.shutdown("main threw").finally(() => process.exit(1));
});
