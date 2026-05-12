/**
 * Probe 20 — Cold-launch race: WS upgrades on P1 vs. concurrent extra login.
 *
 * Context: in production cold launch, the debug log shows a small number
 * (typically 3 of 12) of sub-mode streams closing pre-frame with code 1006
 * and `Received bad response code from server: 400`. Probe 02 refuted the
 * "newer login invalidates older session's new upgrades" hypothesis (serial
 * upgrades on an old session all succeeded after a newer login). Probe 06
 * shows a single session caps at 6 concurrent WS upgrades — fire more and
 * the overflow returns 400. Neither explains the 3-of-12 pattern cleanly.
 *
 * The one ingredient those probes didn't combine: firing parallel WS upgrades
 * on the primary session while an extra-session login is ALSO in flight.
 * That's exactly what `preloadSessionsFor` + `reopenStreams` do at cold launch.
 *
 * Method: three conditions, run N_RUNS times each. Each run needs a fresh
 * primary login because repeated reconnects stack at the NVR's session cap.
 *
 *   A) baseline   — 6 parallel preview/sub WS upgrades on P1, no P2 login.
 *                   Expected: all 6 succeed (within per-session cap).
 *   B) concurrent — 6 parallel upgrades on P1 fired at t=0, plus a fresh
 *                   P2 login fired at t=0 (no await between). P2 isn't used
 *                   to open anything — we only care whether its in-flight
 *                   existence affects P1's upgrades.
 *   C) full-fan   — 12 parallel upgrades: 6 on P1 fired at t=0, P2 login
 *                   fired at t=0, and once P2 resolves the remaining 6 fire
 *                   on P2. This is the closest analog to production.
 *
 * Interpretation:
 *   - If A and B both pass clean but C produces failures on P1, the race is
 *     between P2's login-completion and P1's still-upgrading WSes (possibly
 *     a connection-level rate-limit or reset).
 *   - If B and C both produce failures and A doesn't, concurrent login alone
 *     (not the P2 opens) is enough to break P1.
 *   - If A also produces failures, the per-session cap story from probe 06
 *     was incomplete and something else is going on.
 */
import {
  loadCredentials,
  login,
  listOnlineChannels,
  openStream,
  sleep,
  writeResult,
  watchdog,
  type NvrSession,
  type OpenAttempt,
  type OpenHandle,
} from "./harness";

const N_RUNS = 3;
/** How many upgrades to fire on the primary session in each run. 6 = the
 *  NVR's per-session cap verified by probe 06. Going below gives us headroom
 *  so the cap alone wouldn't explain any failures. */
const P1_UPGRADES = 6;
/** Time between runs — gives the NVR a moment to reclaim session slots. */
const INTER_RUN_SLEEP_MS = 2500;
/** Upgrade handles have their own timeout; this is the outer guard. */
const FIRST_FRAME_TIMEOUT_MS = 6000;
/** Overall kill switch. N_RUNS × 3 conditions × ~8s each + login overhead. */
const WATCHDOG_MS = 180_000;

interface RunOutcome {
  run: number;
  condition: "baseline" | "concurrent" | "full-fan";
  p1SessionId: string;
  p2SessionId?: string;
  p1LoginMs: number;
  p2LoginMs?: number;
  /** Wall-ms between P2 login start and P2 login resolve, observed from
   *  probe's perspective — i.e. including scheduler jitter. */
  p2LoginWallMs?: number;
  p1Attempts: OpenAttempt[];
  p2Attempts?: OpenAttempt[];
  /** True if at least one P1 upgrade hit HTTP 400. */
  p1HadFailure: boolean;
  /** How many P1 upgrades got HTTP 400. */
  p1Fail400: number;
  /** How many P2 upgrades got HTTP 400 (full-fan only). */
  p2Fail400?: number;
}

async function cleanup(handles: OpenHandle[]): Promise<void> {
  for (const h of handles) {
    try {
      await h.close();
    } catch {
      // best-effort
    }
  }
}

function fireUpgrades(
  session: NvrSession,
  channels: string[],
  count: number,
  labelPrefix: string,
): OpenHandle[] {
  const handles: OpenHandle[] = [];
  for (let i = 0; i < count; i++) {
    handles.push(
      openStream(session, {
        kind: "preview",
        channelId: channels[i % channels.length],
        mode: "sub",
        label: `${labelPrefix}-${i + 1}`,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
      }),
    );
  }
  return handles;
}

function summarize(a: OpenAttempt): string {
  return (
    `upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
    `httpStatus=${a.upgradeHttpStatus ?? "-"} ` +
    `closeCode=${a.closeCode ?? "-"} ` +
    `firstFrameMs=${a.firstFrameMs ?? "-"} ` +
    `err=${a.firstFrameError ?? "-"}`
  );
}

async function runBaseline(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  const p1 = await login(creds);
  console.log(
    `  [baseline run ${run}] P1 login ${p1.loginMs}ms sessionId=${p1.sessionId.slice(0, 8)}`,
  );
  const handles = fireUpgrades(p1, channels, P1_UPGRADES, `bl${run}-P1`);
  await Promise.all(handles.map((h) => h.done));
  for (const h of handles) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);

  const p1Attempts = handles.map((h) => h.attempt);
  const p1Fail400 = p1Attempts.filter((a) => a.upgradeHttpStatus === 400).length;
  await cleanup(handles);
  return {
    run,
    condition: "baseline",
    p1SessionId: p1.sessionId,
    p1LoginMs: p1.loginMs,
    p1Attempts,
    p1HadFailure: p1Fail400 > 0,
    p1Fail400,
  };
}

async function runConcurrent(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  const p1 = await login(creds);
  console.log(
    `  [concurrent run ${run}] P1 login ${p1.loginMs}ms sessionId=${p1.sessionId.slice(0, 8)}`,
  );

  // Fire everything with no awaits in between. P2 login and 6 WS upgrades on
  // P1 start within the same synchronous tick — mirrors preloadSessionsFor +
  // reopenStreams calling order at cold launch.
  const t0 = Date.now();
  const p2Promise = login(creds);
  const handles = fireUpgrades(p1, channels, P1_UPGRADES, `cn${run}-P1`);
  const [p2] = await Promise.all([p2Promise, Promise.all(handles.map((h) => h.done))]);
  const p2WallMs = Date.now() - t0;
  console.log(
    `    P2 login ${p2.loginMs}ms (wall ${p2WallMs}ms) sessionId=${p2.sessionId.slice(0, 8)}`,
  );
  for (const h of handles) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);

  const p1Attempts = handles.map((h) => h.attempt);
  const p1Fail400 = p1Attempts.filter((a) => a.upgradeHttpStatus === 400).length;
  await cleanup(handles);
  return {
    run,
    condition: "concurrent",
    p1SessionId: p1.sessionId,
    p2SessionId: p2.sessionId,
    p1LoginMs: p1.loginMs,
    p2LoginMs: p2.loginMs,
    p2LoginWallMs: p2WallMs,
    p1Attempts,
    p1HadFailure: p1Fail400 > 0,
    p1Fail400,
  };
}

async function runFullFan(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  const p1 = await login(creds);
  console.log(
    `  [full-fan run ${run}] P1 login ${p1.loginMs}ms sessionId=${p1.sessionId.slice(0, 8)}`,
  );

  // Same as concurrent for the P1 half. Once P2 resolves, immediately fire
  // its 6 upgrades — no artificial gap, so the sequence matches
  // getAvailableSession's overflow wake-up path.
  const t0 = Date.now();
  const p2Promise = login(creds);
  const p1Handles = fireUpgrades(p1, channels, P1_UPGRADES, `ff${run}-P1`);
  const p2 = await p2Promise;
  const p2WallMs = Date.now() - t0;
  console.log(
    `    P2 login ${p2.loginMs}ms (wall ${p2WallMs}ms) sessionId=${p2.sessionId.slice(0, 8)}`,
  );
  const p2Handles = fireUpgrades(p2, channels, P1_UPGRADES, `ff${run}-P2`);
  await Promise.all([...p1Handles, ...p2Handles].map((h) => h.done));

  for (const h of p1Handles) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);
  for (const h of p2Handles) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);

  const p1Attempts = p1Handles.map((h) => h.attempt);
  const p2Attempts = p2Handles.map((h) => h.attempt);
  const p1Fail400 = p1Attempts.filter((a) => a.upgradeHttpStatus === 400).length;
  const p2Fail400 = p2Attempts.filter((a) => a.upgradeHttpStatus === 400).length;
  await cleanup([...p1Handles, ...p2Handles]);
  return {
    run,
    condition: "full-fan",
    p1SessionId: p1.sessionId,
    p2SessionId: p2.sessionId,
    p1LoginMs: p1.loginMs,
    p2LoginMs: p2.loginMs,
    p2LoginWallMs: p2WallMs,
    p1Attempts,
    p2Attempts,
    p1HadFailure: p1Fail400 > 0 || p2Fail400 > 0,
    p1Fail400,
    p2Fail400,
  };
}

async function main() {
  watchdog(WATCHDOG_MS);
  const creds = loadCredentials();

  // One "discovery" login to list channels — we won't use this session for
  // probe opens since we want each run to start from a fresh primary.
  const bootstrap = await login(creds);
  let channels = await listOnlineChannels(bootstrap);
  if (channels.length === 0) {
    throw new Error("no online channels available for probe");
  }
  // The probe needs up to P1_UPGRADES distinct channels for a realistic
  // multi-channel burst; if the NVR has fewer, cycle through what we have.
  if (channels.length < P1_UPGRADES) {
    console.log(
      `only ${channels.length} online channels — upgrades will reuse channelIds`,
    );
  }
  channels = channels.slice(0, Math.max(P1_UPGRADES, channels.length));
  console.log(`using ${channels.length} channel(s) for bursts`);

  const outcomes: RunOutcome[] = [];

  console.log(`\n— BASELINE (${N_RUNS}× ${P1_UPGRADES}-parallel on fresh P1, no P2) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runBaseline(i, channels, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  console.log(`\n— CONCURRENT (${N_RUNS}× P1 burst + P2 login at t=0) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runConcurrent(i, channels, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  console.log(`\n— FULL-FAN (${N_RUNS}× 6 on P1 + 6 on P2, P2 login concurrent) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runFullFan(i, channels, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  // Aggregate
  const agg = {
    baseline: outcomes.filter((o) => o.condition === "baseline"),
    concurrent: outcomes.filter((o) => o.condition === "concurrent"),
    fullFan: outcomes.filter((o) => o.condition === "full-fan"),
  };
  const summaryFor = (rs: RunOutcome[]) => {
    const p1FailTotal = rs.reduce((s, r) => s + r.p1Fail400, 0);
    const p2FailTotal = rs.reduce((s, r) => s + (r.p2Fail400 ?? 0), 0);
    const runsWithFailure = rs.filter((r) => r.p1HadFailure).length;
    return {
      runs: rs.length,
      p1UpgradesPerRun: P1_UPGRADES,
      runsWithP1Failure: runsWithFailure,
      totalP1Fail400: p1FailTotal,
      totalP2Fail400: p2FailTotal,
    };
  };

  const summary = {
    baseline: summaryFor(agg.baseline),
    concurrent: summaryFor(agg.concurrent),
    fullFan: summaryFor(agg.fullFan),
    interpretation:
      "If baseline is clean and concurrent/full-fan show P1 failures, the race is " +
      "between P2 login completion and P1's still-upgrading WSes. If all three " +
      "are clean, the production 400s are from a different cause (possibly the " +
      "primary session already being stale when reopenStreams fires, e.g. " +
      "handleForeground running twice, or saved-session reuse after the NVR " +
      "rebooted). Compare failure counts — the production signal was 3-of-12, " +
      "so look for ~25-50% failure rates rather than 0% or 100%.",
  };

  writeResult("20-upgrade-vs-login-race", { summary, outcomes });

  console.log(`\n=== summary ===`);
  console.log(
    `baseline:   ${summary.baseline.runsWithP1Failure}/${summary.baseline.runs} runs had P1 failure, ${summary.baseline.totalP1Fail400} total P1 400s`,
  );
  console.log(
    `concurrent: ${summary.concurrent.runsWithP1Failure}/${summary.concurrent.runs} runs had P1 failure, ${summary.concurrent.totalP1Fail400} total P1 400s`,
  );
  console.log(
    `full-fan:   ${summary.fullFan.runsWithP1Failure}/${summary.fullFan.runs} runs had P1 failure, ${summary.fullFan.totalP1Fail400} total P1 400s (${summary.fullFan.totalP2Fail400} P2 400s)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
