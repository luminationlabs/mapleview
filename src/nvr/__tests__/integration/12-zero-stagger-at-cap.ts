/**
 * Probe 12 — Is per-session stagger still needed at cap?
 *
 * Background: `client.ts` serializes WS upgrades on the same session with a
 * 300ms stagger (`OPEN_STAGGER_MS`). Probe 03 already showed that 4 opens at
 * any delay (including 0ms) succeed 100%. Probe 06 showed that 12 opens at
 * 0ms produce 6 successes + 6 HTTP 400s — but that's the over-cap case, and
 * the failures are driven by the session cap, not by burst rate.
 *
 * The gap is the realistic "stagger removed" cold-launch case: exactly 6
 * opens on one session at zero stagger. If that reliably succeeds across
 * several trials, the stagger is dead weight and can be removed — the app
 * would save up to 1.5s of tail on every session's first batch of streams.
 *
 * Method:
 *   For each trial in [1..TRIALS]:
 *     1. Login freshly (avoids interaction with prior-trial state).
 *     2. Wait POST_LOGIN_SETTLE_MS (probe 05 says this isn't needed, but
 *        keep it for parity with probe 03 so results are comparable).
 *     3. Fire BURST_SIZE (=6) preview opens on that session synchronously,
 *        back-to-back in the same microtask — no sleep between them.
 *     4. Wait for every open to settle (upgrade + first frame, or error).
 *     5. Close all handles, sleep COOLDOWN_MS, move on.
 *
 * What to look for:
 *   - Per-trial success rate. 6/6 on every trial → stagger is not needed.
 *   - Any single upgrade 400 → the stagger has a real effect at cap and
 *     removing it would regress. Note whether the failure pattern is
 *     deterministic (always same slot index) or random.
 *   - Aggregate success rate across trials. Single-trial 6/6 could be
 *     luck; we want to see it hold over N trials.
 *
 * Not tested here (intentionally):
 *   - Cross-session bursts. Distribution across sessions is a client-side
 *     concern (`getAvailableSession`); what this probe measures is purely
 *     the NVR's tolerance for a burst of upgrades on one session.
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

const BURST_SIZE = 6;
const TRIALS = 5;
const POST_LOGIN_SETTLE_MS = 500;
const COOLDOWN_MS = 2000;
const FIRST_FRAME_TIMEOUT_MS = 8000;

interface TrialResult {
  trial: number;
  sessionId: string;
  loginMs: number;
  attempts: OpenAttempt[];
  successCount: number;
  upgradeFailCount: number;
  status400Count: number;
}

async function runTrial(
  trial: number,
  creds: ReturnType<typeof loadCredentials>,
  channelId: string,
): Promise<TrialResult> {
  const session = await login(creds);
  await sleep(POST_LOGIN_SETTLE_MS);
  console.log(
    `\ntrial ${trial}/${TRIALS} session=${session.sessionId.slice(0, 8)} — firing ${BURST_SIZE} opens at zero stagger`,
  );

  const handles = [];
  const attempts: OpenAttempt[] = [];
  try {
    // Synchronous loop — no awaits between opens. Each openStream returns a
    // handle immediately; WS construction happens in the same microtask, so
    // the upgrade HTTP requests fire back-to-back without JS-side delay.
    for (let i = 0; i < BURST_SIZE; i++) {
      const h = openStream(session, {
        kind: "preview",
        channelId,
        mode: "sub",
        label: `t${trial}-${i + 1}`,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
      });
      handles.push(h);
      attempts.push(h.attempt);
    }
    await Promise.all(handles.map((h) => h.done));

    for (const a of attempts) {
      console.log(
        `  ${a.label}: upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
          `httpStatus=${a.upgradeHttpStatus ?? "-"} ` +
          `firstFrameMs=${a.firstFrameMs ?? "-"} ` +
          `err=${a.firstFrameError ?? "-"}`,
      );
    }

    const successCount = attempts.filter(
      (a) => a.upgradeSuccess && !a.firstFrameError,
    ).length;
    const upgradeFailCount = attempts.filter((a) => !a.upgradeSuccess).length;
    const status400Count = attempts.filter(
      (a) => a.upgradeHttpStatus === 400,
    ).length;

    return {
      trial,
      sessionId: session.sessionId,
      loginMs: session.loginMs,
      attempts,
      successCount,
      upgradeFailCount,
      status400Count,
    };
  } finally {
    for (const h of handles) await h.close();
  }
}

async function main() {
  watchdog(180_000);
  const creds = loadCredentials();
  // Resolve channelId once so every trial hits the same channel.
  const bootstrap = await login(creds);
  const channelId = await pickChannelId(bootstrap, creds);

  const results: TrialResult[] = [];
  for (let t = 1; t <= TRIALS; t++) {
    const r = await runTrial(t, creds, channelId);
    results.push(r);
    if (t < TRIALS) await sleep(COOLDOWN_MS);
  }

  const totalOpens = TRIALS * BURST_SIZE;
  const totalSuccess = results.reduce((s, r) => s + r.successCount, 0);
  const totalStatus400 = results.reduce((s, r) => s + r.status400Count, 0);
  const perfectTrials = results.filter(
    (r) => r.successCount === BURST_SIZE,
  ).length;

  const verdict =
    totalSuccess === totalOpens
      ? `CLEAN — ${totalSuccess}/${totalOpens} opens succeeded across ${TRIALS} trials at zero stagger. Per-session stagger is not load-bearing at cap; OPEN_STAGGER_MS can be set to 0 (or removed).`
      : `FAILURES — ${totalSuccess}/${totalOpens} opens succeeded (${perfectTrials}/${TRIALS} perfect trials, ${totalStatus400} HTTP 400s). Stagger still has an effect at cap; examine the per-attempt log for the failure pattern before removing it.`;

  writeResult("12-zero-stagger-at-cap", {
    summary: {
      burstSize: BURST_SIZE,
      trials: TRIALS,
      totalOpens,
      totalSuccess,
      totalStatus400,
      perfectTrials,
      verdict,
    },
    trials: results,
  });

  console.log("\n--- summary ---");
  console.log(
    `total ok=${totalSuccess}/${totalOpens} perfect trials=${perfectTrials}/${TRIALS} http400=${totalStatus400}`,
  );
  console.log(verdict);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
