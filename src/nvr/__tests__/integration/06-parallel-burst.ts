/**
 * Probe 06 — Parallel-burst reproduces the client.ts race.
 *
 * Hypothesis: when N > 6 cameras attach in the same tick at cold launch, the
 * app's `getAvailableSession` races. Each of N concurrent `doOpen()` calls
 * reads `streamCountForSession(primary)` BEFORE any of them has written into
 * `streamSessions`. All N see `0 < 6` and pick the primary. By the time the
 * first 6 upgrade successfully, the 7th+ hit the NVR's cap and get HTTP 400.
 *
 * Method:
 *   Fire `BURST_SIZE` parallel WS opens on a SINGLE logged-in session — no
 *   stagger between them. Mirrors the worst-case production behavior where
 *   all opens end up routed to the primary.
 *
 * What to look for:
 *   - Exactly CAP (=6) successes.
 *   - BURST_SIZE - CAP = 6 failures with HTTP 400.
 *
 * This is the smoking gun: if production were correctly distributing opens
 * across 2 sessions (primary + extra), we'd see no 400s. We see 400s, so
 * the code is routing everything to one session — exactly what this probe
 * reproduces deterministically.
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

const BURST_SIZE = 12;
const POST_LOGIN_SETTLE_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 8000;

async function main() {
  watchdog(60_000);
  const creds = loadCredentials();
  const session = await login(creds);
  const channelId = await pickChannelId(session, creds);
  await sleep(POST_LOGIN_SETTLE_MS);
  console.log(
    `sessionId=${session.sessionId.slice(0, 8)} — firing ${BURST_SIZE} parallel opens`,
  );

  // Fire all BURST_SIZE opens synchronously. This is what the app does today:
  // attach() → scheduleOpen() → doOpen() → all N land in the same microtask
  // queue before any advances past `await getAvailableSession()`.
  const handles = [];
  const attempts: OpenAttempt[] = [];
  for (let i = 0; i < BURST_SIZE; i++) {
    const h = openStream(session, {
      kind: "preview",
      channelId,
      mode: "sub",
      label: `burst-${i + 1}`,
      firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
    });
    handles.push(h);
    attempts.push(h.attempt);
  }

  try {
    // Wait for all to settle
    await Promise.all(handles.map((h) => h.done));

    for (const a of attempts) {
      console.log(
        `  ${a.label}: upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
          `httpStatus=${a.upgradeHttpStatus ?? "-"} ` +
          `firstFrameMs=${a.firstFrameMs ?? "-"} ` +
          `err=${a.firstFrameError ?? "-"}`,
      );
    }

    const successes = attempts.filter(
      (a) => a.upgradeSuccess && !a.firstFrameError,
    ).length;
    const failures = attempts.filter((a) => !a.upgradeSuccess).length;
    const status400 = attempts.filter((a) => a.upgradeHttpStatus === 400).length;

    const summary = {
      burstSize: BURST_SIZE,
      sessionId: session.sessionId,
      channelId,
      successes,
      failures,
      status400,
      reproduces:
        successes === 6 && status400 === BURST_SIZE - 6
          ? `YES — exactly 6 upgrades succeeded, ${status400} got HTTP 400. Matches the production pattern: 12 cameras pile onto one session, 6 succeed, 6 fail.`
          : `Partial — ${successes}/${BURST_SIZE} succeeded, ${status400} got 400. Expected 6 and 6 if the race explanation is complete; deviation may indicate timing-dependent effects worth investigating.`,
    };
    writeResult("06-parallel-burst", { summary, attempts });

    console.log(
      `\nsuccesses=${successes} failures=${failures} status400=${status400}`,
    );
    console.log(summary.reproduces);
  } finally {
    for (const h of handles) await h.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
