/**
 * Probe 05 — How long after a fresh login is a WS upgrade reliably accepted?
 *
 * Sanity check: if upgrades succeed at t ≈ 0ms post-login every time, there's
 * no "settle window" and client.ts doesn't need any post-login delay. If
 * they fail at t=0 but succeed at t=100ms, there's a window to respect.
 *
 * Method:
 *   Repeat ITERATIONS times:
 *     1. Login (record login duration).
 *     2. Immediately attempt one WS upgrade. Record upgrade outcome / ms.
 *     3. Close.
 *     4. Sleep BETWEEN_ITERATIONS_MS (both to avoid server-side rate limiting
 *        and to detach any lingering session state).
 *
 * Also run a second group with a short post-login sleep (e.g. 100ms, 250ms)
 * for comparison.
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

const ITERATIONS = 5;
const SETTLE_WINDOWS_MS = [0, 50, 100, 250, 500];
const BETWEEN_ITERATIONS_MS = 1500;
const FIRST_FRAME_TIMEOUT_MS = 6000;

interface Sample {
  settleMs: number;
  iteration: number;
  loginMs: number;
  attempt: OpenAttempt;
  postLoginWaitMs: number;
}

async function main() {
  watchdog(240_000);
  const creds = loadCredentials();
  // Bootstrap a session once just to pick a stable channel id
  const bootstrap = await login(creds);
  const channelId = await pickChannelId(bootstrap, creds);

  const samples: Sample[] = [];

  for (const settleMs of SETTLE_WINDOWS_MS) {
    console.log(`\nsettleMs=${settleMs} (iterations=${ITERATIONS})`);
    for (let i = 0; i < ITERATIONS; i++) {
      const sess = await login(creds);
      if (settleMs > 0) await sleep(settleMs);
      const preOpen = Date.now();
      const h = openStream(sess, {
        kind: "preview",
        channelId,
        mode: "sub",
        label: `settle-${settleMs}-iter-${i + 1}`,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
      });
      await h.done;
      const a = h.attempt;
      console.log(
        `  iter ${i + 1}: loginMs=${sess.loginMs} postLoginWait=${settleMs} ` +
          `upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
          `httpStatus=${a.upgradeHttpStatus ?? "-"} ` +
          `upgradeMs=${a.upgradeMs ?? "-"} ` +
          `firstFrameMs=${a.firstFrameMs ?? "-"} ` +
          `err=${a.firstFrameError ?? "-"}`,
      );
      samples.push({
        settleMs,
        iteration: i + 1,
        loginMs: sess.loginMs,
        postLoginWaitMs: Date.now() - preOpen,
        attempt: a,
      });
      await h.close();
      await sleep(BETWEEN_ITERATIONS_MS);
    }
  }

  // Aggregate
  const byWindow = SETTLE_WINDOWS_MS.map((settleMs) => {
    const mine = samples.filter((s) => s.settleMs === settleMs);
    const successes = mine.filter((s) => s.attempt.upgradeSuccess && !s.attempt.firstFrameError);
    const upgradeMsValues = successes
      .map((s) => s.attempt.upgradeMs)
      .filter((v): v is number => typeof v === "number");
    const avg =
      upgradeMsValues.length > 0
        ? upgradeMsValues.reduce((a, b) => a + b, 0) / upgradeMsValues.length
        : null;
    return {
      settleMs,
      successes: successes.length,
      total: mine.length,
      fraction: mine.length === 0 ? 0 : successes.length / mine.length,
      avgUpgradeMs: avg,
    };
  });

  writeResult("05-post-login-settle", { byWindow, samples });

  console.log("\n--- summary ---");
  for (const w of byWindow) {
    console.log(
      `settleMs=${w.settleMs} ok=${w.successes}/${w.total} ` +
        `avgUpgradeMs=${w.avgUpgradeMs?.toFixed(1) ?? "-"}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
