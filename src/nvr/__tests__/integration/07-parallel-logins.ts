/**
 * Probe 07 — Are parallel logins safe?
 *
 * Hypothesis: `extraLoginChain` in client.ts serializes all extra-session
 * logins one at a time because "parallel logins race through preloadSessionsFor
 * invalidate each other server-side". Probe 02 already showed that new logins
 * don't invalidate old session WS upgrades — but maybe the logins themselves
 * fail or return bogus tokens when raced? This probe checks that directly.
 *
 * Method:
 *   1. Fire N `login()` calls in parallel.
 *   2. Each should complete with a valid (unique) sessionId, nonce, token.
 *   3. Verify each returned sessionId can open a WS (HTTP 101 on Upgrade).
 *
 * What to look for:
 *   - All N logins resolve without throwing.
 *   - N distinct sessionIds.
 *   - WS upgrades succeed on all N sessions immediately afterwards.
 *
 * If this passes: `extraLoginChain` can be removed. If any login fails or a
 * resulting session can't open WSes, the serialization is load-bearing and
 * stays.
 */
import {
  loadCredentials,
  login,
  pickChannelId,
  openStream,
  sleep,
  writeResult,
  watchdog,
} from "./harness";

const N_PARALLEL = 4;
const POST_LOGIN_SETTLE_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 6000;

async function main() {
  watchdog(90_000);
  const creds = loadCredentials();
  console.log(`firing ${N_PARALLEL} parallel logins`);

  const started = Date.now();
  const loginResults = await Promise.allSettled(
    Array.from({ length: N_PARALLEL }, () => login(creds)),
  );
  const totalMs = Date.now() - started;
  console.log(`all ${N_PARALLEL} login promises settled in ${totalMs}ms`);

  const sessions = loginResults
    .filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof login>>> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value);
  const rejected = loginResults.filter((r) => r.status === "rejected");

  console.log(`  fulfilled=${sessions.length} rejected=${rejected.length}`);
  rejected.forEach((r, i) => {
    const err = (r as PromiseRejectedResult).reason;
    console.log(
      `  rejection ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  // Check sessionId uniqueness
  const ids = sessions.map((s) => s.sessionId);
  const uniqueIds = new Set(ids);
  console.log(`  sessionIds: ${ids.length} issued, ${uniqueIds.size} unique`);
  const duplicates = ids.length - uniqueIds.size;

  await sleep(POST_LOGIN_SETTLE_MS);

  // Now verify WS upgrades work on each session. Pick a channel once with
  // the first session; channel list is NVR-wide, not session-specific.
  const channelId =
    sessions.length > 0 ? await pickChannelId(sessions[0], creds) : null;

  const wsAttempts: {
    sessionIdShort: string;
    upgradeSuccess: boolean;
    firstFrameMs?: number;
    err?: string;
  }[] = [];

  if (channelId) {
    console.log(`\nverifying WS upgrade on each session`);
    for (const s of sessions) {
      const h = openStream(s, {
        kind: "preview",
        channelId,
        mode: "sub",
        label: `verify-${s.sessionId.slice(0, 8)}`,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
      });
      await h.done;
      const a = h.attempt;
      wsAttempts.push({
        sessionIdShort: s.sessionId.slice(0, 8),
        upgradeSuccess: a.upgradeSuccess,
        firstFrameMs: a.firstFrameMs,
        err: a.firstFrameError,
      });
      console.log(
        `  ${s.sessionId.slice(0, 8)}: upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
          `firstFrameMs=${a.firstFrameMs ?? "-"} err=${a.firstFrameError ?? "-"}`,
      );
      await h.close();
      await sleep(200);
    }
  }

  const wsFailures = wsAttempts.filter((a) => !a.upgradeSuccess || a.err).length;

  const verdict =
    rejected.length === 0 && duplicates === 0 && wsFailures === 0
      ? `SAFE — ${N_PARALLEL} parallel logins all returned distinct, usable sessions. extraLoginChain serialization is unnecessary.`
      : `NOT SAFE — rejected=${rejected.length} duplicates=${duplicates} wsFailures=${wsFailures}. Keep extraLoginChain.`;

  writeResult("07-parallel-logins", {
    nParallel: N_PARALLEL,
    totalLoginMs: totalMs,
    fulfilled: sessions.length,
    rejected: rejected.length,
    uniqueIds: uniqueIds.size,
    duplicates,
    wsAttempts,
    verdict,
  });

  console.log(`\n${verdict}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
