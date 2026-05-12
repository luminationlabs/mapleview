/**
 * Probe 21 — Cold-launch kitchen-sink stress.
 *
 * Probe 20 was clean for (6 upgrades on P1) vs (P2 login concurrent) and
 * the full 6+6 fan-out. Production still shows 3-of-12 pre-frame 400s at
 * cold launch. This probe widens the search with scenarios that probe 20
 * didn't hit in isolation but that can cooccur at cold launch:
 *
 *   D) kitchen-sink — fire 12 WS upgrades (distributed 6/6 across P1 and
 *      a yet-to-complete P2 login) PLUS an extra login (P3) firing in
 *      parallel — mimics `preloadSessionsFor` called twice (once from
 *      connect, once from handleForeground firing during the iOS Local
 *      Network permission inactive→active cycle), PLUS an enumerateCameras
 *      HTTP request in flight at the same moment. That's 12 WS upgrades +
 *      2 logins + 1 HTTP query all hitting the NVR within microseconds —
 *      close to what reopenStreams + preloadSessionsFor + connect do
 *      during the cold-launch race window.
 *   E) rapid-close-reopen — 6 WS upgrades on P1 opened and allowed to go
 *      ALIVE (first-frame), then closed cleanly via the app's close()
 *      (which sends preview/close + ws.close()), then immediately 6 fresh
 *      WS upgrades on the SAME session. Probe 08 measured a 500 ms
 *      slot-release delay after a clean close — if reopenStreams fires
 *      during the in-flight window and then new scheduleOpens target the
 *      same session, we'd see the tail collide with the stale slot count.
 *   F) mid-upgrade-interrupt — 6 WS upgrades on P1, closed at ~15 ms
 *      (before first-frame, so either in CONNECTING or just-OPEN state),
 *      then 6 fresh upgrades on the same session. Tests the pre-alive
 *      close path that probe 08 didn't directly cover.
 *
 * 3 runs of each. Fresh P1 per run.
 */
import { request as httpRequest } from "node:http";
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
const P1_UPGRADES = 6;
const INTER_RUN_SLEEP_MS = 2500;
const FIRST_FRAME_TIMEOUT_MS = 6000;
const WATCHDOG_MS = 240_000;

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
    } catch {
      // best-effort
    }
  }
}

function summarize(a: OpenAttempt): string {
  return (
    `upgrade=${a.upgradeSuccess ? "ok" : "FAIL"} ` +
    `status=${a.upgradeHttpStatus ?? "-"} ` +
    `closeCode=${a.closeCode ?? "-"} ` +
    `firstFrameMs=${a.firstFrameMs ?? "-"} ` +
    `err=${a.firstFrameError ?? "-"}`
  );
}

/** Rough analog of enumerateCameras — fires a single HTTP POST to
 *  queryOnlineChlList. Used to simulate the enumerate call racing with
 *  WS upgrades and logins in the kitchen-sink condition. */
function fireEnumerate(session: NvrSession): Promise<{ ok: boolean; ms: number }> {
  const body =
    `<?xml version="1.0" encoding="utf-8" ?>` +
    `<request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
    `<token>${session.token}</token></request>`;
  const start = Date.now();
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: session.host,
        port: 80,
        path: "/queryOnlineChlList",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Connection: "close",
          Cookie: `sessionId=${session.sessionId}`,
          Referer: `http://${session.host}/`,
          "Content-Length": Buffer.byteLength(body, "utf-8"),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ ok: (res.statusCode ?? 0) < 300, ms: Date.now() - start }),
        );
      },
    );
    req.on("error", () => resolve({ ok: false, ms: Date.now() - start }));
    req.write(body);
    req.end();
  });
}

interface RunOutcome {
  run: number;
  condition: string;
  p1SessionId: string;
  details: Record<string, unknown>;
  p1Fail400: number;
  p2Fail400: number;
  totalFailures: number;
}

async function runKitchenSink(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  const p1 = await login(creds);
  console.log(
    `  [kitchen-sink run ${run}] P1 login ${p1.loginMs}ms sid=${p1.sessionId.slice(0, 8)}`,
  );

  // Everything fires synchronously. P1_UPGRADES go on P1 directly, 6 more wait
  // for P2 (cold-launch preload). P3 login fires too (handleForeground preload).
  // enumerate HTTP request also fires.
  const enumeratePromise = fireEnumerate(p1);
  const p2LoginPromise = login(creds);
  const p3LoginPromise = login(creds);
  const p1Handles = fireUpgrades(p1, channels, P1_UPGRADES, `ks${run}-P1`);

  // Once P2 ready, fire 6 on it (mirrors cold-launch awaiting doOpens resuming).
  const p2 = await p2LoginPromise;
  const p2Handles = fireUpgrades(p2, channels, P1_UPGRADES, `ks${run}-P2`);

  // Wait for everything
  const [p3, enumerate] = await Promise.all([
    p3LoginPromise,
    enumeratePromise,
    Promise.all(p1Handles.map((h) => h.done)),
    Promise.all(p2Handles.map((h) => h.done)),
  ]);

  for (const h of p1Handles) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);
  for (const h of p2Handles) console.log(`    ${h.attempt.label}: ${summarize(h.attempt)}`);
  console.log(
    `    P2 login ${p2.loginMs}ms, P3 login ${p3.loginMs}ms, enumerate ${enumerate.ok ? "ok" : "FAIL"} ${enumerate.ms}ms`,
  );

  const p1Fail400 = p1Handles.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  const p2Fail400 = p2Handles.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  await cleanup([...p1Handles, ...p2Handles]);

  return {
    run,
    condition: "kitchen-sink",
    p1SessionId: p1.sessionId,
    details: {
      p2SessionId: p2.sessionId,
      p3SessionId: p3.sessionId,
      enumerateOk: enumerate.ok,
      enumerateMs: enumerate.ms,
      p2LoginMs: p2.loginMs,
      p3LoginMs: p3.loginMs,
      p1Attempts: p1Handles.map((h) => h.attempt),
      p2Attempts: p2Handles.map((h) => h.attempt),
    },
    p1Fail400,
    p2Fail400,
    totalFailures: p1Fail400 + p2Fail400,
  };
}

async function runRapidCloseReopen(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  const p1 = await login(creds);
  console.log(
    `  [rapid-close-reopen run ${run}] P1 login ${p1.loginMs}ms sid=${p1.sessionId.slice(0, 8)}`,
  );

  // First wave — let them go fully ALIVE (first-frame), then close via the
  // probe harness's close() which sends preview/close + ws.close().
  const firstWave = fireUpgrades(p1, channels, P1_UPGRADES, `rc${run}-first`);
  await Promise.all(firstWave.map((h) => h.done));
  for (const h of firstWave) console.log(`    first ${h.attempt.label}: ${summarize(h.attempt)}`);
  await cleanup(firstWave); // clean close: preview/close + ws.close()

  // Immediately — no delay — fire the second wave on the same session.
  const secondWave = fireUpgrades(p1, channels, P1_UPGRADES, `rc${run}-second`);
  await Promise.all(secondWave.map((h) => h.done));
  for (const h of secondWave) console.log(`    second ${h.attempt.label}: ${summarize(h.attempt)}`);

  const firstFail400 = firstWave.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  const secondFail400 = secondWave.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  await cleanup(secondWave);

  return {
    run,
    condition: "rapid-close-reopen",
    p1SessionId: p1.sessionId,
    details: {
      firstAttempts: firstWave.map((h) => h.attempt),
      secondAttempts: secondWave.map((h) => h.attempt),
    },
    p1Fail400: secondFail400,
    p2Fail400: 0,
    totalFailures: firstFail400 + secondFail400,
  };
}

async function runMidUpgradeInterrupt(
  run: number,
  channels: string[],
  creds: ReturnType<typeof loadCredentials>,
): Promise<RunOutcome> {
  const p1 = await login(creds);
  console.log(
    `  [mid-upgrade-interrupt run ${run}] P1 login ${p1.loginMs}ms sid=${p1.sessionId.slice(0, 8)}`,
  );

  // First wave — close aggressively at ~15ms (before first-frame). The
  // probe's openStream returns a handle synchronously; h.ws is the raw ws
  // instance. terminate() mirrors an iOS-killed socket or an in-flight
  // reopenStreams close on a CONNECTING socket.
  const firstWave = fireUpgrades(p1, channels, P1_UPGRADES, `mu${run}-first`);
  await sleep(15);
  for (const h of firstWave) {
    try {
      h.ws?.terminate();
    } catch {
      // best-effort
    }
  }
  await Promise.all(firstWave.map((h) => h.done));
  for (const h of firstWave) console.log(`    first ${h.attempt.label}: ${summarize(h.attempt)}`);

  // Immediately fire the second wave on the same session.
  const secondWave = fireUpgrades(p1, channels, P1_UPGRADES, `mu${run}-second`);
  await Promise.all(secondWave.map((h) => h.done));
  for (const h of secondWave) console.log(`    second ${h.attempt.label}: ${summarize(h.attempt)}`);

  const firstFail400 = firstWave.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  const secondFail400 = secondWave.filter((h) => h.attempt.upgradeHttpStatus === 400).length;
  await cleanup(secondWave);

  return {
    run,
    condition: "mid-upgrade-interrupt",
    p1SessionId: p1.sessionId,
    details: {
      firstAttempts: firstWave.map((h) => h.attempt),
      secondAttempts: secondWave.map((h) => h.attempt),
    },
    p1Fail400: secondFail400,
    p2Fail400: 0,
    totalFailures: firstFail400 + secondFail400,
  };
}

async function main() {
  watchdog(WATCHDOG_MS);
  const creds = loadCredentials();

  const bootstrap = await login(creds);
  const channels = await listOnlineChannels(bootstrap);
  if (channels.length === 0) throw new Error("no online channels");
  const chans = channels.slice(0, Math.max(P1_UPGRADES, channels.length));
  console.log(`using ${chans.length} channel(s)`);

  const outcomes: RunOutcome[] = [];

  console.log(`\n— D) KITCHEN-SINK (${N_RUNS}× 12 upgrades + 2 logins + enumerate) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runKitchenSink(i, chans, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  console.log(`\n— E) RAPID-CLOSE-REOPEN (${N_RUNS}× 6 alive + clean close + 6 fresh on same session) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runRapidCloseReopen(i, chans, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  console.log(`\n— F) MID-UPGRADE-INTERRUPT (${N_RUNS}× 6 fire, abort @ 15ms, 6 fresh) —`);
  for (let i = 1; i <= N_RUNS; i++) {
    outcomes.push(await runMidUpgradeInterrupt(i, chans, creds));
    await sleep(INTER_RUN_SLEEP_MS);
  }

  const sumFor = (condition: string) => {
    const rs = outcomes.filter((o) => o.condition === condition);
    const total400 = rs.reduce((s, r) => s + r.p1Fail400 + r.p2Fail400, 0);
    const withFail = rs.filter((r) => r.totalFailures > 0).length;
    return { runs: rs.length, total400, runsWithFailure: withFail };
  };

  const summary = {
    kitchenSink: sumFor("kitchen-sink"),
    rapidCloseReopen: sumFor("rapid-close-reopen"),
    midUpgradeInterrupt: sumFor("mid-upgrade-interrupt"),
  };

  writeResult("21-coldlaunch-stress", { summary, outcomes });

  console.log(`\n=== summary ===`);
  console.log(
    `kitchen-sink:         ${summary.kitchenSink.runsWithFailure}/${summary.kitchenSink.runs} runs with failure, ${summary.kitchenSink.total400} total 400s`,
  );
  console.log(
    `rapid-close-reopen:   ${summary.rapidCloseReopen.runsWithFailure}/${summary.rapidCloseReopen.runs} runs with failure, ${summary.rapidCloseReopen.total400} total 400s`,
  );
  console.log(
    `mid-upgrade-interrupt: ${summary.midUpgradeInterrupt.runsWithFailure}/${summary.midUpgradeInterrupt.runs} runs with failure, ${summary.midUpgradeInterrupt.total400} total 400s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
