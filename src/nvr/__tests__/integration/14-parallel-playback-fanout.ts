/**
 * Probe 14 — parallel playback fan-out: first-frame latency + steady-state
 * delivery when N>MAX_STREAMS_PER_SESSION playbacks are opened in parallel.
 *
 * Reproduces the Recorded-tab scenario that appears to drive the stuck /
 * recover / stuck cascade: a scrub (or initial openAll) restarts every
 * channel's playback connection at once. The first CAP streams can pack onto
 * the primary session; the rest spill to extra sessions. Extra-session logins
 * are serialized by `getAvailableSession`'s loop (one new login per full
 * pool). Each login takes ~4-5s on this NVR (observed in user-supplied logs),
 * which is already close to `LOADING_WATCHDOG_MS = 5000`.
 *
 * Unknowns the probe measures directly against the real device:
 *
 * (a) **Session-pool serialization cost.** How long does caller #7 (and #8,
 *     #9...) wait for a session slot compared to caller #1? If #7+ exceed 5s
 *     before their WS even opens, the app's loading watchdog is guaranteed to
 *     fire on them — reopen → back in queue → repeat.
 *
 * (b) **First-keyframe latency under fan-out.** Once a stream has a session
 *     and upgrades, how long until the first keyframe arrives? A lightly-
 *     loaded NVR delivers the first IDR within a few hundred ms; under N
 *     parallel playbacks it may starve some streams.
 *
 * (c) **Steady-state fairness.** After everyone is streaming, do the N
 *     connections share keyframes evenly, or does the server starve some?
 *     Probe samples 30s of steady-state inter-keyframe gaps per stream and
 *     reports the max. Any stream whose max gap > 5s under steady-state ACK
 *     cadence means the 5s watchdog will fire during normal playback, which
 *     matches the user-reported "stuck / recover / stuck" oscillation.
 *
 * Out of scope (deliberate): this probe does NOT exercise the preBuffer /
 * pacing / GOP-observer logic. Those are JS-only and covered by unit tests.
 * The goal here is to isolate what the *server* does under fan-out load, so
 * we know whether the stuck cascade is fixable in the client alone or
 * whether it needs a protocol-level workaround.
 *
 * Protocol (per stream):
 *   1. Acquire a session slot from the probe-local pool (mirrors
 *      `getAvailableSession`: primary first; when cap=6 reached, kick off a
 *      new login serially, future callers share the pending).
 *   2. Open WS on assigned session.
 *   3. On create_connection#response: send /device/playback/open + all_frame
 *      (at 1x) + audio/close (same 3-command burst the client sends).
 *   4. On each inbound video frame: if seq % FLOW_CONTROL_INTERVAL === 0,
 *      send refresh_play_index(seq). Matches the app at 1x all-frame mode.
 *   5. Record arrival wall-time + isKey for every video frame.
 *   6. Stop at OBSERVE_SECONDS after first keyframe (or timeout waiting for
 *      it).
 *
 * Summary output:
 *   - sessionAcquireMs, upgradeMs, createConnectionMs, firstKeyframeMs per
 *     stream
 *   - openReqToFirstKeyframeMs (end-to-end; compare to 5000ms watchdog)
 *   - Steady-state max inter-keyframe gap per stream
 *   - Count of streams exceeding the watchdog at each stage
 *   - Verdict: which stage (pool, open, first-kf, steady-state) is the
 *     dominant source of watchdog-length latency.
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

/** Mirrors client.ts:82. If this diverges from the real value, probe numbers
 *  stop being a faithful reproduction of the production pool. */
const MAX_STREAMS_PER_SESSION = 6;
/** Mirrors playback-connection.ts:44. Only ACK on every 8th frame in all-frame. */
const FLOW_CONTROL_INTERVAL = 8;
/** Watchdog threshold we're trying to beat at every stage (playback-connection.ts:261). */
const LOADING_WATCHDOG_MS = 5000;
/** Fan-out: how many parallel playbacks to run. Default 8 — enough to force
 *  one extra-session login (primary holds 6, extra holds 2). Override with
 *  PROBE_FANOUT_N to sweep. */
const FANOUT_N = Number(process.env.PROBE_FANOUT_N ?? 8);
/** Steady-state observation window, per stream, starting at first keyframe. */
const OBSERVE_SECONDS = Number(process.env.PROBE_OBSERVE_SECONDS ?? 30);
/** Per-stream upper bound for getting to first keyframe before we give up. */
const FIRST_KF_TIMEOUT_MS = 15_000;
/** Post-login settle grace before firing opens — matches probe 04/06. */
const POST_LOGIN_SETTLE_MS = 500;
/** Hard ceiling per login attempt so a wedged /reqLogin endpoint can't hang the
 *  whole probe. Matches the NVR's typical happy-path login of ~1-5s with
 *  generous headroom. */
const LOGIN_HARD_TIMEOUT_MS = 15_000;
/** Hard kill for the whole probe. Scales with fan-out because a large N forces
 *  serialized extra-session logins (one login per full pool iteration). Budget:
 *  primary login + worst-case extras + observation + generous shutdown grace. */
const WATCHDOG_MS =
  LOGIN_HARD_TIMEOUT_MS +
  Math.ceil(FANOUT_N / MAX_STREAMS_PER_SESSION) * LOGIN_HARD_TIMEOUT_MS +
  FIRST_KF_TIMEOUT_MS +
  OBSERVE_SECONDS * 1000 +
  30_000;

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

/** Tracks every WS + task_id the probe opened so a forcible exit can still
 *  try to tell the NVR "close this playback task" before the TCP socket dies.
 *  Without this, killed probes leave playback tasks + sessions stranded on the
 *  server until its own timeout elapses — which, observationally, can wedge
 *  /reqLogin and require a power cycle. */
interface OpenStreamEntry {
  ws: WebSocket;
  taskId: string;
  label: string;
}
class CleanupRegistry {
  private readonly streams = new Map<string, OpenStreamEntry>();
  /** Flip flag so nothing opens new connections after shutdown has started. */
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

  /** Send /device/playback/close on every still-open WS and then close them.
   *  Best-effort — swallows per-socket errors because the caller is already
   *  exiting. Resolves after a short grace period so the close frames have a
   *  chance to reach the NVR before the process exits. */
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const entries = [...this.streams.values()];
    if (entries.length === 0) return;
    console.error(`[cleanup] ${reason}: closing ${entries.length} open streams`);
    for (const { ws, taskId, label } of entries) {
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
      } catch (err) {
        console.error(`[cleanup] ${label}: send close failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Give the close frames a moment to flush before ws.close() kills the socket.
    await sleep(250);
    for (const { ws, label } of entries) {
      try {
        ws.close();
      } catch (err) {
        console.error(`[cleanup] ${label}: ws.close failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Second grace so the TCP FINs land cleanly.
    await sleep(250);
  }
}

const cleanupRegistry = new CleanupRegistry();

/** Install signal + crash handlers that attempt cleanup before exit. Async
 *  handlers use an outer timeout so a wedged close can't hang termination. */
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
  process.on("SIGINT", () => {
    void run("SIGINT", 130);
  });
  process.on("SIGTERM", () => {
    void run("SIGTERM", 143);
  });
  process.on("uncaughtException", (err) => {
    console.error("uncaughtException:", err);
    void run("uncaughtException", 1);
  });
  process.on("unhandledRejection", (err) => {
    console.error("unhandledRejection:", err);
    void run("unhandledRejection", 1);
  });
}

/** Replacement for harness.watchdog(): times out the whole probe, but runs the
 *  cleanup registry first so the NVR doesn't inherit orphan sessions. */
function installHardWatchdog(ms: number): NodeJS.Timeout {
  return setTimeout(() => {
    console.error(`\n[watchdog] ${ms}ms elapsed — cleaning up and exiting`);
    void cleanupRegistry.shutdown("watchdog").finally(() => process.exit(2));
  }, ms).unref();
}

/** Wrap probeLogin with a hard timeout so a wedged /reqLogin endpoint can't
 *  hang the probe indefinitely. */
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

/** Minimal session pool mirroring client.ts:getAvailableSession. Serializes
 *  extra-session logins the same way the app does (one pending login shared
 *  by all overflow callers; next login starts only when all known sessions
 *  are full again). Measures per-acquire wait time. */
interface PoolSession {
  session: NvrSession;
  claims: number;
}
class SessionPool {
  private readonly sessions: PoolSession[] = [];
  private pendingLogin: Promise<NvrSession | null> | null = null;
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  /** Counter for labeling extra-session logins in the probe output. */
  private extraSessionCounter = 0;
  /** Timing history for each login, written to the final JSON report. */
  readonly loginTimings: { label: string; startedAtMs: number; durationMs: number; sessionId: string }[] = [];

  constructor(primary: NvrSession, username: string, password: string) {
    this.sessions.push({ session: primary, claims: 0 });
    this.host = primary.host;
    this.username = username;
    this.password = password;
  }

  async acquire(label: string): Promise<{ session: NvrSession; waitMs: number }> {
    const startedAt = Date.now();
    for (let iter = 0; iter < 20; iter++) {
      for (const s of this.sessions) {
        if (s.claims < MAX_STREAMS_PER_SESSION) {
          s.claims++;
          return { session: s.session, waitMs: Date.now() - startedAt };
        }
      }
      if (this.pendingLogin) {
        await this.pendingLogin;
        continue;
      }
      this.extraSessionCounter++;
      const extraLabel = `extra-${this.extraSessionCounter}`;
      const loginStartedAt = Date.now();
      console.log(`[pool] ${label}: all ${this.sessions.length} sessions full — starting ${extraLabel} login`);
      this.pendingLogin = loginWithTimeout(
        { host: this.host, username: this.username, password: this.password },
        LOGIN_HARD_TIMEOUT_MS,
        extraLabel,
      )
        .then((fresh) => {
          const dur = Date.now() - loginStartedAt;
          this.loginTimings.push({
            label: extraLabel,
            startedAtMs: loginStartedAt,
            durationMs: dur,
            sessionId: fresh.sessionId,
          });
          this.sessions.push({ session: fresh, claims: 0 });
          console.log(`[pool] ${extraLabel} ready in ${dur}ms (total sessions=${this.sessions.length})`);
          return fresh;
        })
        .catch((err) => {
          console.error(`[pool] ${extraLabel} login failed: ${err instanceof Error ? err.message : err}`);
          return null;
        })
        .finally(() => {
          this.pendingLogin = null;
        });
      await this.pendingLogin;
    }
    throw new Error("SessionPool.acquire: exhausted retries (should not happen)");
  }

  snapshot(): { sessionIds: string[]; claimsPerSession: number[] } {
    return {
      sessionIds: this.sessions.map((s) => s.session.sessionId.slice(0, 8)),
      claimsPerSession: this.sessions.map((s) => s.claims),
    };
  }
}

interface StreamTiming {
  label: string;
  channelId: string;
  sessionIdShort: string;
  openRequestedAtMs: number;
  /** Wall ms from openRequested to session slot acquired. */
  sessionAcquireMs: number;
  /** Wall ms from openRequested to WS upgrade (HTTP 101). */
  upgradeMs: number | null;
  /** Wall ms from upgrade to /device/create_connection#response. */
  createConnectionMs: number | null;
  /** Wall ms from openRequested to first video keyframe. */
  firstKeyframeMs: number | null;
  /** Wall ms from first keyframe to last observed frame. */
  observedForMs: number;
  totalFrames: number;
  keyframeCount: number;
  /** Max wall-time gap between consecutive frames, excluding the gap before
   *  the first frame. Only populated once steady state is reached. */
  maxInterFrameGapMs: number;
  /** Max wall-time gap between consecutive keyframes. The one to watch vs.
   *  LOADING_WATCHDOG_MS — if this exceeds 5s, the app watchdog fires during
   *  steady-state playback. */
  maxInterKeyframeGapMs: number;
  /** Non-fatal issue descriptor if anything went wrong. */
  error: string | null;
}

async function runStream(
  pool: SessionPool,
  label: string,
  channelId: string,
  range: { start: number; end: number },
): Promise<StreamTiming> {
  const openRequestedAtMs = Date.now();
  const timing: StreamTiming = {
    label,
    channelId,
    sessionIdShort: "",
    openRequestedAtMs,
    sessionAcquireMs: 0,
    upgradeMs: null,
    createConnectionMs: null,
    firstKeyframeMs: null,
    observedForMs: 0,
    totalFrames: 0,
    keyframeCount: 0,
    maxInterFrameGapMs: 0,
    maxInterKeyframeGapMs: 0,
    error: null,
  };

  let session: NvrSession;
  try {
    const acq = await pool.acquire(label);
    timing.sessionAcquireMs = acq.waitMs;
    session = acq.session;
    timing.sessionIdShort = session.sessionId.slice(0, 8);
  } catch (err) {
    timing.error = `session acquire: ${err instanceof Error ? err.message : String(err)}`;
    return timing;
  }

  if (cleanupRegistry.isShuttingDown()) {
    timing.error = "shutdown in progress before WS open";
    return timing;
  }

  const taskId = generateTaskId();
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  cleanupRegistry.register(label, { ws, taskId, label });

  let upgradeWallMs: number | null = null;
  let lastFrameWallMs: number | null = null;
  let lastKeyframeWallMs: number | null = null;
  let observationStartedAtMs: number | null = null;

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));

  const firstKfTimer = setTimeout(() => {
    if (timing.firstKeyframeMs === null) {
      timing.error = timing.error ?? `first-keyframe timeout after ${FIRST_KF_TIMEOUT_MS}ms`;
      resolveDone();
    }
  }, FIRST_KF_TIMEOUT_MS);

  let observeTimer: NodeJS.Timeout | null = null;

  ws.on("upgrade", () => {
    upgradeWallMs = Date.now();
    timing.upgradeMs = upgradeWallMs - openRequestedAtMs;
  });

  ws.on("unexpected-response", (_req, res) => {
    timing.error = timing.error ?? `upgrade HTTP ${res.statusCode}`;
    try {
      res.resume();
    } catch {
      /* best-effort */
    }
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
      const shfl = parseSHFL(wsFrame.payload);
      if (!(shfl.frameType === 0 || shfl.frameType === 4)) return;
      if (shfl.payload.byteLength === 0) return;

      const nowMs = Date.now();
      timing.totalFrames++;
      if (lastFrameWallMs !== null) {
        const gap = nowMs - lastFrameWallMs;
        if (gap > timing.maxInterFrameGapMs) timing.maxInterFrameGapMs = gap;
      }
      lastFrameWallMs = nowMs;

      if (shfl.isKeyFrame) {
        timing.keyframeCount++;
        if (timing.firstKeyframeMs === null) {
          timing.firstKeyframeMs = nowMs - openRequestedAtMs;
          clearTimeout(firstKfTimer);
          observationStartedAtMs = nowMs;
          observeTimer = setTimeout(() => {
            resolveDone();
          }, OBSERVE_SECONDS * 1000);
        } else if (lastKeyframeWallMs !== null) {
          const kfGap = nowMs - lastKeyframeWallMs;
          if (kfGap > timing.maxInterKeyframeGapMs) timing.maxInterKeyframeGapMs = kfGap;
        }
        lastKeyframeWallMs = nowMs;
      }

      if (shfl.seq > 0 && shfl.seq % FLOW_CONTROL_INTERVAL === 0) {
        sendAck(shfl.seq);
      }
    } catch {
      // Malformed frame shouldn't crash the probe.
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
      if (upgradeWallMs !== null) {
        timing.createConnectionMs = Date.now() - upgradeWallMs;
      }
      ws.send(
        JSON.stringify({
          url: "/device/playback/open",
          basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
          data: {
            task_id: taskId,
            channel_id: channelId,
            start_time: range.start,
            end_time: range.end,
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
      ws.send(
        JSON.stringify({
          url: "/device/playback/all_frame",
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
      return;
    }
    if (msg.url === "/device/playback/open#response") {
      const code = msg.basic?.code;
      if (typeof code === "number" && code !== 0) {
        timing.error = timing.error ?? `playback/open code=${code} msg=${msg.basic?.msg ?? ""}`;
        resolveDone();
      }
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
  ws.on("error", () => {
    // Surfaced via 'unexpected-response' / 'close'; avoid double-recording.
  });

  await done;
  clearTimeout(firstKfTimer);
  if (observeTimer) clearTimeout(observeTimer);
  if (observationStartedAtMs !== null) {
    timing.observedForMs = Date.now() - observationStartedAtMs;
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
    /* best-effort */
  }
  cleanupRegistry.unregister(label);
  return timing;
}

async function pickChannels(session: NvrSession, want: number): Promise<string[]> {
  const online = await listOnlineChannels(session);
  if (online.length === 0) {
    throw new Error("No online channels on NVR — probe needs at least 1");
  }
  const result: string[] = [];
  for (let i = 0; i < want; i++) {
    result.push(online[i % online.length]);
  }
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
    `config: fanoutN=${FANOUT_N} observeSeconds=${OBSERVE_SECONDS} ` +
      `loginTimeoutMs=${LOGIN_HARD_TIMEOUT_MS} watchdogMs=${WATCHDOG_MS}`,
  );
  const creds = loadCredentials();
  let primary: NvrSession;
  try {
    primary = await loginWithTimeout(creds, LOGIN_HARD_TIMEOUT_MS, "primary");
  } catch (err) {
    console.error(`primary login failed: ${err instanceof Error ? err.message : err}`);
    console.error(
      `The NVR may be wedged or unreachable; aborting without opening any streams.`,
    );
    process.exit(1);
  }
  console.log(`primary login ok in ${primary.loginMs}ms (sessionId=${primary.sessionId.slice(0, 8)})`);
  await sleep(POST_LOGIN_SETTLE_MS);

  const channels = await pickChannels(primary, FANOUT_N);
  const range = defaultPlaybackRange(creds);
  console.log(
    `fanout N=${FANOUT_N}, channels=${channels.map((c) => c.slice(1, 9)).join(",")}, ` +
      `playback range ${range.start}..${range.end}, observe ${OBSERVE_SECONDS}s`,
  );
  console.log(
    `thresholds: LOADING_WATCHDOG_MS=${LOADING_WATCHDOG_MS}, MAX_STREAMS_PER_SESSION=${MAX_STREAMS_PER_SESSION}`,
  );

  const pool = new SessionPool(primary, creds.username, creds.password);
  const startedAtMs = Date.now();
  const timings = await Promise.all(
    channels.map((channelId, i) =>
      runStream(pool, `stream-${i + 1}`, channelId, range),
    ),
  );
  const wallMs = Date.now() - startedAtMs;

  const acquire = timings.map((t) => t.sessionAcquireMs);
  const upgrade = timings.filter((t) => t.upgradeMs !== null).map((t) => t.upgradeMs!);
  const createConn = timings.filter((t) => t.createConnectionMs !== null).map((t) => t.createConnectionMs!);
  const firstKf = timings.filter((t) => t.firstKeyframeMs !== null).map((t) => t.firstKeyframeMs!);
  const maxKfGap = timings.map((t) => t.maxInterKeyframeGapMs);

  const wouldWatchdogFireAtFirstKf = timings.filter(
    (t) => t.firstKeyframeMs === null || t.firstKeyframeMs > LOADING_WATCHDOG_MS,
  );
  const wouldWatchdogFireSteadyState = timings.filter(
    (t) => t.maxInterKeyframeGapMs > LOADING_WATCHDOG_MS,
  );
  const failures = timings.filter((t) => t.error !== null);

  console.log(`\n=== timings (per stream) ===`);
  for (const t of timings) {
    const fkf = t.firstKeyframeMs === null ? "—" : `${t.firstKeyframeMs}ms`;
    const err = t.error ? ` ERROR=${t.error}` : "";
    console.log(
      `${t.label} ch=${t.channelId.slice(1, 9)} sess=${t.sessionIdShort} ` +
        `acq=${t.sessionAcquireMs}ms upgrade=${t.upgradeMs}ms cc=${t.createConnectionMs}ms firstKf=${fkf} ` +
        `kfs=${t.keyframeCount} maxKfGap=${t.maxInterKeyframeGapMs}ms${err}`,
    );
  }

  console.log(`\n=== distributions ===`);
  console.log(bucket(acquire, "sessionAcquireMs"));
  console.log(bucket(upgrade, "upgradeMs"));
  console.log(bucket(createConn, "createConnectionMs"));
  console.log(bucket(firstKf, "firstKeyframeMs"));
  console.log(bucket(maxKfGap, "maxInterKeyframeGapMs"));

  console.log(`\n=== watchdog crossings (LOADING_WATCHDOG_MS=${LOADING_WATCHDOG_MS}) ===`);
  console.log(
    `first-keyframe exceeded or never arrived: ${wouldWatchdogFireAtFirstKf.length}/${timings.length}`,
  );
  console.log(
    `steady-state keyframe gap exceeded:       ${wouldWatchdogFireSteadyState.length}/${timings.length}`,
  );

  let verdict: string;
  if (failures.length > 0 && failures.length === timings.length) {
    verdict =
      `All ${timings.length} streams failed before first keyframe. ` +
      `This is a harness / credentials / network problem, not a fan-out issue. ` +
      `Check the per-stream errors above.`;
  } else if (wouldWatchdogFireAtFirstKf.length > 0 && wouldWatchdogFireSteadyState.length === 0) {
    verdict =
      `${wouldWatchdogFireAtFirstKf.length}/${timings.length} streams took >${LOADING_WATCHDOG_MS}ms to reach first keyframe. ` +
      `Steady-state delivery was fine once open. ` +
      `=> Bottleneck is the open path (session-login serialization + upgrade + initial IDR). ` +
      `The stuck cascade the user sees is NOT a server-fairness problem — it's the watchdog firing before the pool can ` +
      `spin up sessions fast enough under fan-out. Plausible fixes: parallelize extra-session logins up front ` +
      `(preloadSessionsFor at scrub time), or make LOADING_WATCHDOG_MS account for acquire time (start the timer at ` +
      `session acquisition, not at open()).`;
  } else if (wouldWatchdogFireSteadyState.length > 0) {
    verdict =
      `${wouldWatchdogFireSteadyState.length}/${timings.length} streams had a keyframe gap >${LOADING_WATCHDOG_MS}ms ` +
      `during steady-state playback. The NVR is NOT delivering fairly to N=${FANOUT_N} parallel playbacks at 1x. ` +
      `=> The watchdog is firing during normal playback, not just during open. This is a server-fairness issue — ` +
      `consider reducing N (pause background channels while in single-cam, or don't reopen them on every seek), ` +
      `lengthening LOADING_WATCHDOG_MS, or staggering seekAll's per-channel restarts so they don't all land in the ` +
      `same flow-control window.`;
  } else {
    verdict =
      `All ${timings.length} streams reached first keyframe within ${LOADING_WATCHDOG_MS}ms and held steady. ` +
      `No fan-out-induced watchdog crossing reproduced. The user's cascade may be triggered by something we're ` +
      `not simulating (user-paused background connections, the pre-buffer path, or a specific seek race).`;
  }

  const summary = {
    params: {
      fanoutN: FANOUT_N,
      observeSeconds: OBSERVE_SECONDS,
      loadingWatchdogMs: LOADING_WATCHDOG_MS,
      maxStreamsPerSession: MAX_STREAMS_PER_SESSION,
      flowControlInterval: FLOW_CONTROL_INTERVAL,
      playbackRange: range,
    },
    totalWallMs: wallMs,
    poolLoginTimings: pool.loginTimings,
    poolSnapshotAtEnd: pool.snapshot(),
    timings,
    wouldWatchdogFireAtFirstKf: wouldWatchdogFireAtFirstKf.length,
    wouldWatchdogFireSteadyState: wouldWatchdogFireSteadyState.length,
    failureCount: failures.length,
    verdict,
  };
  console.log(`\n=== verdict ===\n${verdict}`);
  writeResult("14-parallel-playback-fanout", summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
