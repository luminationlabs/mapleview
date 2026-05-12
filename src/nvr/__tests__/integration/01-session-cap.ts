/**
 * Probe 01 — Per-session WebSocket cap.
 *
 * Hypothesis: the NVR caps concurrent WebSocket streams per session at some
 * number N (assumed 6 in client.ts#MAX_STREAMS_PER_SESSION). Opens beyond N
 * are rejected during the HTTP Upgrade handshake.
 *
 * Method:
 *   1. Login once.
 *   2. Wait POST_LOGIN_SETTLE_MS so the session is definitely settled (no
 *      parallel logins in flight that could invalidate it).
 *   3. Open MAX_ATTEMPTS preview WSes sequentially, with OPEN_SPACING_MS
 *      between each. Large spacing so we're not racing the stagger; this
 *      measures the cap, not the burst-rate.
 *   4. For each attempt, record upgrade outcome and (if successful) whether
 *      a first frame arrives.
 *
 * What to look for: the smallest attempt index that fails. That index - 1 is
 * the per-session cap.
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

const MAX_ATTEMPTS = 10;
const OPEN_SPACING_MS = 500;
const POST_LOGIN_SETTLE_MS = 500;
const PER_ATTEMPT_FIRST_FRAME_TIMEOUT_MS = 5000;

async function main() {
  watchdog(90_000);
  const creds = loadCredentials();
  const session = await login(creds);
  const channelId = await pickChannelId(session, creds);

  console.log(
    `logged in sessionId=${session.sessionId.slice(0, 8)} loginMs=${session.loginMs}`,
  );
  console.log(`probing cap on channel=${channelId} (sub-stream)`);

  await sleep(POST_LOGIN_SETTLE_MS);

  const handles = [];
  const attempts: OpenAttempt[] = [];

  try {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const h = openStream(session, {
        kind: "preview",
        channelId,
        mode: "sub",
        label: `attempt-${i + 1}`,
        firstFrameTimeoutMs: PER_ATTEMPT_FIRST_FRAME_TIMEOUT_MS,
      });
      handles.push(h);
      attempts.push(h.attempt);
      // Wait for this attempt to settle (first frame, timeout, or rejection)
      // before starting the next so we know the ordered outcome.
      await h.done;
      const a = h.attempt;
      console.log(
        `  ${a.label}: upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
          `httpStatus=${a.upgradeHttpStatus ?? "-"} ` +
          `closeCode=${a.closeCode ?? "-"} ` +
          `upgradeMs=${a.upgradeMs ?? "-"} ` +
          `firstFrameMs=${a.firstFrameMs ?? "-"}` +
          (a.firstFrameError ? ` err=${a.firstFrameError}` : ""),
      );
      await sleep(OPEN_SPACING_MS);
    }

    const cap = attempts.findIndex((a) => !a.upgradeSuccess);
    const summary = {
      sessionId: session.sessionId,
      loginMs: session.loginMs,
      channelId,
      attemptsMade: MAX_ATTEMPTS,
      detectedCap: cap === -1 ? `>=${MAX_ATTEMPTS}` : cap,
      firstFailureIndex: cap === -1 ? null : cap,
      notes:
        cap === -1
          ? `All ${MAX_ATTEMPTS} opens succeeded — cap is higher than tested range.`
          : `Attempt ${cap + 1} (0-indexed ${cap}) was the first to fail, so cap ≈ ${cap}.`,
    };

    writeResult("01-session-cap", { summary, attempts });
  } finally {
    for (const h of handles) await h.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
