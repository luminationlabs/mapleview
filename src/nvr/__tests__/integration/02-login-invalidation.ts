/**
 * Probe 02 — New login invalidates old session for new WS upgrades.
 *
 * Hypothesis (from the code comments / our reasoning): when a new login
 * completes for the same user, the NVR invalidates the previous session's
 * token for **new** WS upgrades. Existing WSes that already upgraded keep
 * delivering frames. This is what drives the ~400s we see in production when
 * `preloadSessionsFor` fires extra logins in parallel with initial WS opens.
 *
 * Method:
 *   1. Login → session A. Open a preview WS on A, wait for first frame.
 *   2. Login → session B (same user).
 *   3. Attempt a fresh preview WS on A at t ∈ {0, 100, 500, 2000} ms after
 *      B's login completed. Record upgrade outcome / HTTP status / close code.
 *   4. After each attempt, verify the ORIGINAL WS on A is still receiving
 *      frames (via a lightweight liveness probe).
 *   5. Repeat one more cycle: login → C, check whether session B is now the
 *      invalidated one.
 *
 * What to look for:
 *   - firstAttemptToFail → tells us the settle window.
 *   - existing WS on A survives → confirms the "old WS keeps running" rule.
 *   - When C completes, opens on B fail → confirms only the newest session
 *     accepts new WSes (rolling invalidation).
 */
import {
  loadCredentials,
  login,
  pickChannelId,
  openStream,
  sleep,
  writeResult,
  watchdog,
  type NvrSession,
  type OpenAttempt,
} from "./harness";

const POST_B_DELAYS_MS = [0, 100, 500, 2000];
const ORIGINAL_WS_LIVENESS_CHECK_MS = 250;
const POST_LOGIN_SETTLE_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 6000;

async function openOnSession(
  sess: NvrSession,
  channelId: string,
  label: string,
) {
  const h = openStream(sess, {
    kind: "preview",
    channelId,
    mode: "sub",
    label,
    firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
  });
  await h.done;
  return h;
}

/**
 * Check whether a WebSocket is still open and whether the latest first-frame
 * flag is set on its handle. Note: this probe doesn't stream frames continuously
 * (would fill the pacing window) — it just checks readyState.
 */
function isHandleAlive(h: { ws: { readyState: number } | null }): boolean {
  return !!h.ws && h.ws.readyState === 1; // OPEN
}

async function main() {
  watchdog(120_000);
  const creds = loadCredentials();

  // Session A
  const sessionA = await login(creds);
  const channelId = await pickChannelId(sessionA, creds);
  await sleep(POST_LOGIN_SETTLE_MS);
  console.log(
    `sessionA=${sessionA.sessionId.slice(0, 8)} loginMs=${sessionA.loginMs}`,
  );

  // Establish a known-good WS on A
  const firstOnA = await openOnSession(sessionA, channelId, "A-initial");
  console.log(
    `  A-initial: firstFrameMs=${firstOnA.attempt.firstFrameMs ?? "-"} ` +
      `err=${firstOnA.attempt.firstFrameError ?? "-"}`,
  );

  // Login B (same user)
  const tBeforeB = Date.now();
  const sessionB = await login(creds);
  const bReadyAt = Date.now();
  console.log(
    `sessionB=${sessionB.sessionId.slice(0, 8)} loginMs=${sessionB.loginMs} ` +
      `wallGapFromA=${bReadyAt - tBeforeB}ms`,
  );

  // Attempts on A at staggered post-B delays
  const aAttemptsAfterB: OpenAttempt[] = [];
  const aAliveCheckpoints: { atMs: number; aliveA: boolean }[] = [];
  const aHandles: Awaited<ReturnType<typeof openOnSession>>[] = [];

  for (const delay of POST_B_DELAYS_MS) {
    const target = bReadyAt + delay;
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);

    aAliveCheckpoints.push({
      atMs: Date.now() - bReadyAt,
      aliveA: isHandleAlive(firstOnA),
    });

    const h = await openOnSession(sessionA, channelId, `A-after-B+${delay}`);
    aHandles.push(h);
    aAttemptsAfterB.push(h.attempt);
    const a = h.attempt;
    console.log(
      `  A-after-B+${delay}ms: upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
        `httpStatus=${a.upgradeHttpStatus ?? "-"} ` +
        `closeCode=${a.closeCode ?? "-"} ` +
        `firstFrameMs=${a.firstFrameMs ?? "-"} ` +
        `err=${a.firstFrameError ?? "-"}`,
    );

    await sleep(ORIGINAL_WS_LIVENESS_CHECK_MS);
    aAliveCheckpoints.push({
      atMs: Date.now() - bReadyAt,
      aliveA: isHandleAlive(firstOnA),
    });
  }

  // Login C — now try on B to see if the "only newest accepts" rule holds
  const tBeforeC = Date.now();
  const sessionC = await login(creds);
  const cReadyAt = Date.now();
  console.log(
    `sessionC=${sessionC.sessionId.slice(0, 8)} loginMs=${sessionC.loginMs} ` +
      `wallGapFromB=${cReadyAt - tBeforeC}ms`,
  );

  await sleep(500);
  const bAfterC = await openOnSession(sessionB, channelId, "B-after-C");
  console.log(
    `  B-after-C: upgrade=${bAfterC.attempt.upgradeSuccess ? "ok" : "FAIL"} ` +
      `httpStatus=${bAfterC.attempt.upgradeHttpStatus ?? "-"} ` +
      `closeCode=${bAfterC.attempt.closeCode ?? "-"} ` +
      `err=${bAfterC.attempt.firstFrameError ?? "-"}`,
  );
  const cFresh = await openOnSession(sessionC, channelId, "C-fresh");
  console.log(
    `  C-fresh: upgrade=${cFresh.attempt.upgradeSuccess ? "ok" : "FAIL"} ` +
      `err=${cFresh.attempt.firstFrameError ?? "-"}`,
  );

  const failures = aAttemptsAfterB.filter((a) => !a.upgradeSuccess);
  const summary = {
    sessionA: sessionA.sessionId,
    sessionB: sessionB.sessionId,
    sessionC: sessionC.sessionId,
    firstOnA: firstOnA.attempt,
    aAttemptsAfterB,
    aAliveCheckpoints,
    bAfterC: bAfterC.attempt,
    cFresh: cFresh.attempt,
    notes:
      failures.length === 0
        ? "All post-B opens on A succeeded. Hypothesis REFUTED for this firmware — new login does NOT immediately invalidate old session for new upgrades."
        : `Post-B opens on A failed at delays: ${failures
            .map((f) => f.label)
            .join(", ")}. First-alive-A-after-B checkpoint sequence: ${aAliveCheckpoints
            .map((c) => `t=${c.atMs}ms alive=${c.aliveA}`)
            .join("; ")}.`,
  };

  writeResult("02-login-invalidation", summary);

  // Cleanup
  await firstOnA.close();
  for (const h of aHandles) await h.close();
  await bAfterC.close();
  await cFresh.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
