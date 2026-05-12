/**
 * Probe 22 — Full cold-launch simulation with handleForeground interrupt,
 * plus NVR global-cap test.
 *
 * Probe 21's rapid-close-reopen reproduces 3-of-6 on same session. Reasoning
 * through the client code path, production shouldn't hit same-session reopen
 * because `reopenStreams` leaks `streamSessions` entries, making the old
 * session appear full to `getAvailableSession`. So the probe 21 reproduction
 * may not match the actual production path. This probe searches wider:
 *
 *   G) cold-launch-interrupt — mirror the actual client sequence. Fire 6
 *      WS upgrades on P1 (plus P2 login concurrent). While P1 upgrades are
 *      still CONNECTING, simulate `reopenStreams`: call `ws.close()` on 3
 *      CONNECTING WSes (which doesn't actually abort them — matches
 *      StreamConnection.close()'s no-op path on non-OPEN state), then fire
 *      a FRESH wave of 12 upgrades distributed across P1/P2 as the client
 *      would. Count failures on both sessions.
 *   H) global-cap — saturate many sessions in parallel. Login 4 sessions,
 *      then fire 6 WS upgrades on EACH (24 concurrent). If the NVR enforces
 *      a per-session cap of 6 only (probe 01), all 24 should succeed. If
 *      there's also a GLOBAL cap (e.g., 18), ~6 would fail — regardless of
 *      which session each was routed to.
 *   I) cold-launch-x2 — two sets of 12 opens distributed 6/6 across two
 *      session pairs (P1+P2 and P3+P4), all fired in the same microsecond.
 *      If the NVR has a per-IP rate limit or some HTTP-handler thread-pool
 *      limit, piling 24 upgrades + 2 login requests will expose it.
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
const INTER_RUN_SLEEP_MS = 3000;
const FIRST_FRAME_TIMEOUT_MS = 6000;
const WATCHDOG_MS = 300_000;

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

async function cleanup(handles: OpenHandle[]): Promise<void> {
  for (const h of handles) {
    try {
      await h.close();
    } catch { /* best-effort */ }
  }
}

function summarize(a: OpenAttempt): string {
  return (
    `upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
    `status=${a.upgradeHttpStatus ?? "-"} ` +
    `closeCode=${a.closeCode ?? "-"} ` +
    `firstFrameMs=${a.firstFrameMs ?? "-"}`
  );
}

interface RunOutcome {
  run: number;
  condition: string;
  fail400: number;
  totalAttempts: number;
  details: Record<string, unknown>;
}

async function runColdLaunchInterrupt(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  const p1 = await login(creds);
  console.log(
    `  [cold-launch-interrupt ${run}] P1 login ${p1.loginMs}ms sid=${p1.sessionId.slice(0, 8)}`,
  );

  // Simulate cold-launch: fire preload (P2 login) and 6 WS on P1 simultaneously.
  const p2Promise = login(creds);
  const firstWave = fireUpgrades(p1, channels, 6, `ci${run}-first`);

  // Wait a tiny bit — just enough that the WSes are CONNECTING but not yet
  // OPEN/alive. 20-40ms is typical for local WiFi.
  await sleep(30);

  // Abandon first 3 of firstWave by calling ws.close() — this mirrors
  // StreamConnection.close() on a CONNECTING WS: the close() is queued
  // but NVR may still upgrade + allocate the slot before processing the
  // TCP close (or not — that's what we want to measure).
  for (let i = 0; i < 3; i++) {
    try {
      firstWave[i].ws?.close();
    } catch { /* best-effort */ }
  }

  // Wait for P2 login to finish (simulating doOpens for slots 7-12 awaiting).
  const p2 = await p2Promise;
  console.log(
    `    P2 login ${p2.loginMs}ms sid=${p2.sessionId.slice(0, 8)}`,
  );

  // Now simulate reopenStreams scheduling NEW doOpens for all 12 slots.
  // In production these'd claim P1 slots that streamSessions sees as free
  // (the 3 aborted ones would have their streamSessions.set never called
  // if they were still in-flight at abort time). To mirror the client's
  // distribution, we fire 3 on P1 (filling in the abandoned slots) and
  // 6 on P2. The OTHER 3 original streams (that we didn't abandon) are
  // kept alive to simulate streams already committed to streamSessions.
  const secondWaveP1 = fireUpgrades(p1, channels, 3, `ci${run}-second-P1`);
  const secondWaveP2 = fireUpgrades(p2, channels, 6, `ci${run}-second-P2`);

  const all = [...firstWave, ...secondWaveP1, ...secondWaveP2];
  await Promise.all(all.map((h) => h.done));

  for (const h of all) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);

  const fail400 = all.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  await cleanup(all);

  return {
    run,
    condition: "cold-launch-interrupt",
    fail400,
    totalAttempts: all.length,
    details: {
      firstWaveAttempts: firstWave.map((h) => h.attempt),
      secondWaveP1Attempts: secondWaveP1.map((h) => h.attempt),
      secondWaveP2Attempts: secondWaveP2.map((h) => h.attempt),
    },
  };
}

async function runGlobalCap(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  console.log(`  [global-cap ${run}] logging in 4 sessions...`);
  const [p1, p2, p3, p4] = await Promise.all([
    login(creds),
    login(creds),
    login(creds),
    login(creds),
  ]);
  console.log(
    `    P1=${p1.sessionId.slice(0, 8)} P2=${p2.sessionId.slice(0, 8)} P3=${p3.sessionId.slice(0, 8)} P4=${p4.sessionId.slice(0, 8)}`,
  );

  // Fire 6 WS upgrades on each of the 4 sessions, concurrently — 24 total.
  const all: OpenHandle[] = [];
  for (const [idx, sess] of [p1, p2, p3, p4].entries()) {
    all.push(...fireUpgrades(sess, channels, 6, `gc${run}-S${idx + 1}`));
  }
  await Promise.all(all.map((h) => h.done));

  for (const h of all) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);

  const fail400 = all.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  // Sub-session counts so we can see whether failures cluster on specific sessions.
  const bySession: Record<string, { ok: number; fail400: number }> = {};
  for (const h of all) {
    const sid = h.attempt.sessionId.slice(0, 8);
    bySession[sid] = bySession[sid] ?? { ok: 0, fail400: 0 };
    if (h.attempt.upgradeHttpStatus === 400) bySession[sid].fail400++;
    else if (h.attempt.upgradeSuccess) bySession[sid].ok++;
  }
  await cleanup(all);

  return {
    run,
    condition: "global-cap",
    fail400,
    totalAttempts: all.length,
    details: { bySession, attempts: all.map((h) => h.attempt) },
  };
}

async function runColdLaunchX2(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  console.log(`  [cold-launch-x2 ${run}] logging in 4 sessions...`);
  // Fire the 4 logins strictly sequentially so the bursts below can't be
  // "soaked up" by login overhead. All 4 sessions are ready before we fire.
  const p1 = await login(creds);
  const p2 = await login(creds);
  const p3 = await login(creds);
  const p4 = await login(creds);
  console.log(
    `    sessions ready: P1=${p1.sessionId.slice(0, 8)} P2=${p2.sessionId.slice(0, 8)} P3=${p3.sessionId.slice(0, 8)} P4=${p4.sessionId.slice(0, 8)}`,
  );

  // Fire 6 on each of 4 sessions in the same synchronous block. 24 WS
  // upgrades hit the NVR within microseconds of each other.
  const all: OpenHandle[] = [];
  all.push(...fireUpgrades(p1, channels, 6, `cx${run}-P1`));
  all.push(...fireUpgrades(p2, channels, 6, `cx${run}-P2`));
  all.push(...fireUpgrades(p3, channels, 6, `cx${run}-P3`));
  all.push(...fireUpgrades(p4, channels, 6, `cx${run}-P4`));

  await Promise.all(all.map((h) => h.done));

  for (const h of all) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);

  const fail400 = all.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  const bySession: Record<string, { ok: number; fail400: number }> = {};
  for (const h of all) {
    const sid = h.attempt.sessionId.slice(0, 8);
    bySession[sid] = bySession[sid] ?? { ok: 0, fail400: 0 };
    if (h.attempt.upgradeHttpStatus === 400) bySession[sid].fail400++;
    else if (h.attempt.upgradeSuccess) bySession[sid].ok++;
  }
  await cleanup(all);

  return {
    run,
    condition: "cold-launch-x2",
    fail400,
    totalAttempts: all.length,
    details: { bySession, attempts: all.map((h) => h.attempt) },
  };
}

async function main() {
  watchdog(WATCHDOG_MS);
  const creds = loadCredentials();

  const bootstrap = await login(creds);
  const channels = await listOnlineChannels(bootstrap);
  if (channels.length === 0) throw new Error("no online channels");
  const chans = channels.slice(0, Math.max(6, channels.length));
  console.log(`using ${chans.length} channel(s)`);

  const outcomes: RunOutcome[] = [];

  console.log(`\n— G) COLD-LAUNCH-INTERRUPT (${N_RUNS}×) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runColdLaunchInterrupt(i, chans, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  console.log(`\n— H) GLOBAL-CAP (${N_RUNS}× 4 sessions × 6 upgrades = 24 concurrent) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runGlobalCap(i, chans, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  console.log(`\n— I) COLD-LAUNCH-X2 (${N_RUNS}× 24 sync across 4 pre-logged sessions) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runColdLaunchX2(i, chans, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  const sumFor = (cond: string) => {
    const rs = outcomes.filter((o) => o.condition === cond);
    const total400 = rs.reduce((s, r) => s + r.fail400, 0);
    const withFail = rs.filter((r) => r.fail400 > 0).length;
    const totalAttempts = rs.reduce((s, r) => s + r.totalAttempts, 0);
    return { runs: rs.length, total400, runsWithFailure: withFail, totalAttempts };
  };

  const summary = {
    coldLaunchInterrupt: sumFor("cold-launch-interrupt"),
    globalCap: sumFor("global-cap"),
    coldLaunchX2: sumFor("cold-launch-x2"),
  };

  writeResult("22-coldlaunch-fullsim", { summary, outcomes });

  console.log(`\n=== summary ===`);
  console.log(
    `cold-launch-interrupt: ${summary.coldLaunchInterrupt.runsWithFailure}/${summary.coldLaunchInterrupt.runs} runs with failure, ${summary.coldLaunchInterrupt.total400}/${summary.coldLaunchInterrupt.totalAttempts} 400s`,
  );
  console.log(
    `global-cap:            ${summary.globalCap.runsWithFailure}/${summary.globalCap.runs} runs with failure, ${summary.globalCap.total400}/${summary.globalCap.totalAttempts} 400s`,
  );
  console.log(
    `cold-launch-x2:        ${summary.coldLaunchX2.runsWithFailure}/${summary.coldLaunchX2.runs} runs with failure, ${summary.coldLaunchX2.total400}/${summary.coldLaunchX2.totalAttempts} 400s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
