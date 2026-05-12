/**
 * Probe 03 — Minimum safe inter-open delay on a single session.
 *
 * The client staggers opens at 300ms per slot. Is that the right number? Test
 * every common alternative and see where the failure rate kicks in.
 *
 * Method:
 *   For each delay in DELAYS:
 *     1. Login freshly (so post-login settle doesn't confound).
 *     2. Wait POST_LOGIN_SETTLE_MS.
 *     3. Open N_PER_SWEEP WSes back-to-back with `delay` ms between each. Each
 *        open is issued immediately; we do NOT await the previous open's first
 *        frame. This is the "burst" behavior we want to characterize.
 *     4. Wait for all handles to settle (success or failure).
 *     5. Close them all, sleep a cooldown, move on.
 *
 * Rationale for fresh login per sweep: keeps any session-failure eviction
 * bookkeeping on the NVR from affecting later sweeps. Also avoids running up
 * against the per-session cap across sweeps.
 *
 * What to look for: success rate vs delay. If success is 100% at 100ms and
 * drops to, say, 60% at 50ms, the safe threshold is around 100ms (not the
 * current 300ms, which would be overkill).
 */
import {
  loadCredentials,
  login,
  pickChannelId,
  openStream,
  sleep,
  writeResult,
  watchdog,
  type OpenAttempt,
} from "./harness";

const DELAYS = [0, 25, 50, 100, 200, 500, 1000] as const;
const N_PER_SWEEP = 4;
const POST_LOGIN_SETTLE_MS = 500;
const COOLDOWN_BETWEEN_SWEEPS_MS = 2000;
const FIRST_FRAME_TIMEOUT_MS = 6000;

interface SweepResult {
  delayMs: number;
  sessionId: string;
  loginMs: number;
  attempts: OpenAttempt[];
  successCount: number;
  failureCount: number;
}

async function runSweep(delayMs: number, creds: ReturnType<typeof loadCredentials>, channelHint?: string): Promise<SweepResult> {
  const session = await login(creds);
  const channelId = channelHint ?? (await pickChannelId(session, creds));
  await sleep(POST_LOGIN_SETTLE_MS);

  console.log(`\nsweep delay=${delayMs}ms session=${session.sessionId.slice(0, 8)}`);
  const handles = [];
  const attempts: OpenAttempt[] = [];
  try {
    for (let i = 0; i < N_PER_SWEEP; i++) {
      const h = openStream(session, {
        kind: "preview",
        channelId,
        mode: "sub",
        label: `delay-${delayMs}-attempt-${i + 1}`,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
      });
      handles.push(h);
      attempts.push(h.attempt);
      if (i < N_PER_SWEEP - 1 && delayMs > 0) await sleep(delayMs);
    }
    // Wait for every attempt to settle
    await Promise.all(handles.map((h) => h.done));
    for (const a of attempts) {
      console.log(
        `  ${a.label}: upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
          `httpStatus=${a.upgradeHttpStatus ?? "-"} ` +
          `firstFrameMs=${a.firstFrameMs ?? "-"} ` +
          `err=${a.firstFrameError ?? "-"}`,
      );
    }
    const success = attempts.filter((a) => a.upgradeSuccess && !a.firstFrameError).length;
    return {
      delayMs,
      sessionId: session.sessionId,
      loginMs: session.loginMs,
      attempts,
      successCount: success,
      failureCount: N_PER_SWEEP - success,
    };
  } finally {
    for (const h of handles) await h.close();
  }
}

async function main() {
  watchdog(240_000);
  const creds = loadCredentials();
  // Resolve channelId once up front so all sweeps test the same channel.
  const bootstrap = await login(creds);
  const channelId = await pickChannelId(bootstrap, creds);

  const results: SweepResult[] = [];
  for (const d of DELAYS) {
    const r = await runSweep(d, creds, channelId);
    results.push(r);
    await sleep(COOLDOWN_BETWEEN_SWEEPS_MS);
  }

  const summary = results.map((r) => ({
    delayMs: r.delayMs,
    successCount: r.successCount,
    failureCount: r.failureCount,
    fractionOk: r.successCount / N_PER_SWEEP,
  }));

  writeResult("03-stagger-threshold", { summary, results });
  console.log("\n--- summary ---");
  for (const s of summary) {
    console.log(
      `delay=${s.delayMs}ms ok=${s.successCount}/${N_PER_SWEEP} (${(
        s.fractionOk * 100
      ).toFixed(0)}%)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
