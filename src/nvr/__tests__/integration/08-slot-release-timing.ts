/**
 * Probe 08 — When does the NVR release a per-session slot after a WS closes?
 *
 * Motivating scenario: app is on Recorded tab (or grid) with 24 active
 * WebSockets across ~4 sessions. App goes to background. iOS silently kills
 * the WSes (TCP FIN may or may not be delivered; if the app was already
 * fully suspended, the FIN can be delayed or lost). On foreground 5 seconds
 * later we call closeAllStreams which tries to send preview/close on WSes
 * that are already dead — best-effort. Local accounting resets to 0 slots
 * held, but the NVR may still have some slot count for those sessions.
 * Reopening immediately produces HTTP 400 on upgrades that exceed the
 * NVR's (stale) count.
 *
 * This probe characterizes three teardown modes:
 *   A) Clean: send `/device/preview/close`, then ws.close(). Measure how
 *      fast a fresh open on the same session succeeds after.
 *   B) Abrupt: terminate the WS without a close command (ws.terminate())
 *      to simulate an iOS-killed connection.
 *   C) Abrupt + wait N seconds, then try to reopen.
 *
 * What to look for:
 *   - Clean close → reopen immediately succeeds? → then fix is "make sure
 *     close commands are sent before background".
 *   - Abrupt → reopen succeeds only after N seconds of wait? → then fix
 *     is "fresh login on foreground for affected sessions".
 *   - Abrupt → reopens start succeeding once enough time has passed → we
 *     get a T where recovery is reliable; app can wait / evict accordingly.
 */
import WebSocket from "ws";
import {
  loadCredentials,
  login,
  pickChannelId,
  openStream,
  sleep,
  writeResult,
  watchdog,
  type NvrSession,
} from "./harness";

const CAP = 6;
const RECOVERY_CHECK_DELAYS_MS = [0, 500, 1000, 2000, 5000, 10_000, 20_000];
const FIRST_FRAME_TIMEOUT_MS = 5000;

/**
 * Open `count` preview WSes on `session` and wait for each to receive a
 * first frame. Returns the `ws` objects for tear-down in the caller.
 */
async function fillSessionToCap(
  session: NvrSession,
  channelId: string,
  count: number,
) {
  const handles = [];
  for (let i = 0; i < count; i++) {
    const h = openStream(session, {
      kind: "preview",
      channelId,
      mode: "sub",
      label: `fill-${i + 1}`,
      firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
    });
    handles.push(h);
    // Serialize so each gets a first frame before starting the next.
    await h.done;
    if (!h.attempt.firstFrameMs) {
      throw new Error(
        `fill-${i + 1} failed: ${h.attempt.firstFrameError ?? "no first frame"}`,
      );
    }
  }
  return handles;
}

/** Probe a single new open on the session, returning the outcome. */
async function probeOneOpen(
  session: NvrSession,
  channelId: string,
  label: string,
) {
  const h = openStream(session, {
    kind: "preview",
    channelId,
    mode: "sub",
    label,
    firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
  });
  await h.done;
  const ok = h.attempt.upgradeSuccess && !h.attempt.firstFrameError;
  await h.close();
  return {
    ok,
    httpStatus: h.attempt.upgradeHttpStatus,
    closeCode: h.attempt.closeCode,
    firstFrameMs: h.attempt.firstFrameMs,
    err: h.attempt.firstFrameError,
  };
}

type TeardownMode = "clean" | "abrupt";

interface RunResult {
  mode: TeardownMode;
  recoveryAfterMs: number | null; // null = never recovered within tested window
  samples: {
    delayMs: number;
    ok: boolean;
    httpStatus?: number;
    err?: string;
  }[];
}

async function runOneTrial(mode: TeardownMode): Promise<RunResult> {
  const creds = loadCredentials();
  const session = await login(creds);
  const channelId = await pickChannelId(session, creds);
  console.log(`\n[${mode}] session=${session.sessionId.slice(0, 8)}`);

  const handles = await fillSessionToCap(session, channelId, CAP);
  console.log(`  filled session to cap (${CAP} streams)`);

  // Tear down all handles.
  if (mode === "clean") {
    for (const h of handles) await h.close();
    console.log(`  clean teardown: sent preview/close + ws.close()`);
  } else {
    for (const h of handles) {
      if (h.ws) {
        // Skip the preview/close command and call terminate() which
        // immediately closes the socket without sending a TCP FIN (via
        // an RST instead). Simulates iOS abruptly cutting the connection.
        try {
          (h.ws as WebSocket).terminate();
        } catch {
          // best-effort
        }
      }
    }
    console.log(`  abrupt teardown: ws.terminate() (no preview/close)`);
  }

  // Probe recovery at each delay. Use SERIAL probing so one probe's close
  // doesn't confound the next probe's wait.
  const samples: RunResult["samples"] = [];
  let recoveryAfterMs: number | null = null;
  const startedAt = Date.now();
  for (const delay of RECOVERY_CHECK_DELAYS_MS) {
    const target = startedAt + delay;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await probeOneOpen(
      session,
      channelId,
      `${mode}-recover-${delay}`,
    );
    samples.push({
      delayMs: delay,
      ok: res.ok,
      httpStatus: res.httpStatus,
      err: res.err,
    });
    console.log(
      `  t+${delay}ms: ok=${res.ok} httpStatus=${res.httpStatus ?? "-"} err=${res.err ?? "-"}`,
    );
    if (res.ok && recoveryAfterMs === null) recoveryAfterMs = delay;
  }
  return { mode, recoveryAfterMs, samples };
}

async function main() {
  watchdog(240_000);

  const clean = await runOneTrial("clean");
  // Short pause between trials to let things settle.
  await sleep(3000);
  const abrupt = await runOneTrial("abrupt");

  const verdict =
    clean.recoveryAfterMs === 0 && abrupt.recoveryAfterMs === 0
      ? `Both teardown modes recover immediately. NVR releases slots synchronously on socket close regardless of TCP FIN vs RST.`
      : clean.recoveryAfterMs === 0 && abrupt.recoveryAfterMs !== null
        ? `Clean teardown recovers immediately; abrupt needs ~${abrupt.recoveryAfterMs}ms of grace. Fix: on foreground, give sessions this long before reusing them, OR log in fresh sessions.`
        : clean.recoveryAfterMs !== null && abrupt.recoveryAfterMs !== null
          ? `Both teardown modes have a recovery delay (clean: ${clean.recoveryAfterMs}ms, abrupt: ${abrupt.recoveryAfterMs}ms). Even preview/close doesn't fully release slots immediately on this firmware.`
          : `Sessions did not recover within the tested window (clean recovery: ${clean.recoveryAfterMs}, abrupt: ${abrupt.recoveryAfterMs}). Extend RECOVERY_CHECK_DELAYS_MS or switch strategy to fresh logins on foreground.`;

  writeResult("08-slot-release-timing", { clean, abrupt, verdict });
  console.log(`\n${verdict}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
