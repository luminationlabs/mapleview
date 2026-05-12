/**
 * Probe 04 — Is the per-session WS cap shared across preview + playback?
 *
 * client.ts assumes shared (`streamCountForSession` counts both live and
 * playback claims against `MAX_STREAMS_PER_SESSION`). Verify empirically.
 *
 * Method:
 *   1. Login, wait settle.
 *   2. Open 3 preview WSes (staggered 500ms to avoid the burst-rate failure
 *      mode, which probe 03 characterizes separately).
 *   3. Open 3 playback WSes on the same session, 500ms-staggered.
 *   4. All 6 should stream if cap is ≥6 regardless of type split.
 *   5. Open a 7th preview. If cap is shared, it fails. If per-type, it
 *      succeeds.
 *   6. Open a 7th playback. Same interpretation in the other direction.
 *
 * What to look for:
 *   - 6/6 of the initial mix succeed → cap is at least 6.
 *   - 7th preview fails → confirms shared cap (or a per-type cap of 3-ish,
 *     unlikely given the code's assumption).
 *   - 7th preview succeeds → suggests per-type cap (or cap > 6).
 */
import {
  loadCredentials,
  login,
  pickChannelId,
  openStream,
  sleep,
  writeResult,
  watchdog,
  defaultPlaybackRange,
  type OpenAttempt,
} from "./harness";

const STAGGER_MS = 500;
const POST_LOGIN_SETTLE_MS = 500;
const FIRST_FRAME_TIMEOUT_MS = 8000;
const SEVENTH_OPEN_TIMEOUT_MS = 4000;

async function main() {
  watchdog(120_000);
  const creds = loadCredentials();
  const session = await login(creds);
  const channelId = await pickChannelId(session, creds);
  const range = defaultPlaybackRange(creds);
  await sleep(POST_LOGIN_SETTLE_MS);
  console.log(
    `sessionId=${session.sessionId.slice(0, 8)} channel=${channelId} ` +
      `playbackRange=${range.start}..${range.end}`,
  );

  const handles = [];
  const attempts: OpenAttempt[] = [];

  try {
    console.log("\nopening 3 previews...");
    for (let i = 0; i < 3; i++) {
      const h = openStream(session, {
        kind: "preview",
        channelId,
        mode: "sub",
        label: `preview-${i + 1}`,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
      });
      handles.push(h);
      attempts.push(h.attempt);
      await sleep(STAGGER_MS);
    }

    console.log("\nopening 3 playbacks...");
    for (let i = 0; i < 3; i++) {
      const h = openStream(session, {
        kind: "playback",
        channelId,
        mode: "main",
        playbackRange: range,
        label: `playback-${i + 1}`,
        firstFrameTimeoutMs: FIRST_FRAME_TIMEOUT_MS,
      });
      handles.push(h);
      attempts.push(h.attempt);
      await sleep(STAGGER_MS);
    }

    // Wait for the first six to all settle
    await Promise.all(handles.map((h) => h.done));
    const okSoFar = attempts.filter((a) => a.upgradeSuccess && !a.firstFrameError).length;
    console.log(`\nfirst 6: ${okSoFar}/6 ok`);

    // 7th preview — does it hit the cap?
    console.log("\nopening 7th stream (preview)...");
    const seventhPreview = openStream(session, {
      kind: "preview",
      channelId,
      mode: "sub",
      label: "preview-7",
      firstFrameTimeoutMs: SEVENTH_OPEN_TIMEOUT_MS,
    });
    handles.push(seventhPreview);
    attempts.push(seventhPreview.attempt);
    await seventhPreview.done;
    console.log(
      `  preview-7: upgrade=${seventhPreview.attempt.upgradeSuccess ? "ok" : "FAIL"} ` +
        `httpStatus=${seventhPreview.attempt.upgradeHttpStatus ?? "-"} ` +
        `closeCode=${seventhPreview.attempt.closeCode ?? "-"} ` +
        `err=${seventhPreview.attempt.firstFrameError ?? "-"}`,
    );

    // 8th — another playback, for symmetry
    console.log("\nopening 8th stream (playback)...");
    const eighthPlayback = openStream(session, {
      kind: "playback",
      channelId,
      mode: "main",
      playbackRange: range,
      label: "playback-4",
      firstFrameTimeoutMs: SEVENTH_OPEN_TIMEOUT_MS,
    });
    handles.push(eighthPlayback);
    attempts.push(eighthPlayback.attempt);
    await eighthPlayback.done;
    console.log(
      `  playback-4: upgrade=${eighthPlayback.attempt.upgradeSuccess ? "ok" : "FAIL"} ` +
        `httpStatus=${eighthPlayback.attempt.upgradeHttpStatus ?? "-"} ` +
        `closeCode=${eighthPlayback.attempt.closeCode ?? "-"} ` +
        `err=${eighthPlayback.attempt.firstFrameError ?? "-"}`,
    );

    const firstSix = attempts.slice(0, 6);
    const firstSixOk = firstSix.every(
      (a) => a.upgradeSuccess && !a.firstFrameError,
    );
    const seventhOk =
      seventhPreview.attempt.upgradeSuccess &&
      !seventhPreview.attempt.firstFrameError;
    const eighthOk =
      eighthPlayback.attempt.upgradeSuccess &&
      !eighthPlayback.attempt.firstFrameError;

    let verdict: string;
    if (!firstSixOk) {
      verdict =
        "First 6 did not all succeed — cap is lower than 6 or something else interfered. Re-run probe 01 for the pure cap.";
    } else if (seventhOk && eighthOk) {
      verdict =
        "7th AND 8th streams both succeeded — cap is higher than 6 on this firmware, OR caps are per-type and > 3 each.";
    } else if (!seventhOk && !eighthOk) {
      verdict =
        "Both additional streams rejected — consistent with a shared cap of 6 (matches client.ts assumption).";
    } else {
      verdict = `Asymmetric outcome (seventhOk=${seventhOk}, eighthOk=${eighthOk}) — cap may be per-type or timing-dependent. Inspect attempts for details.`;
    }

    writeResult("04-live-playback-mix", {
      sessionId: session.sessionId,
      channelId,
      range,
      attempts,
      verdict,
    });
  } finally {
    for (const h of handles) await h.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
