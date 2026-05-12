/**
 * Probe 11 — reproduce the "8x → 1x plays briefly then skips ~34s ahead
 * and gets stuck" scenario at the protocol level.
 *
 * In the app, the user's symptoms are:
 *   1. Switch from 8x (keyframe mode) to 1x (all-frame mode) after
 *      several seconds of 8x playback.
 *   2. Playback starts briefly, then display jumps ~34s ahead in the
 *      recording and freezes, while the currentTime counter keeps
 *      ticking forward.
 *
 * Two candidate failure locations:
 *   A) Server-side — the NVR delivers frames whose PTS jumps forward
 *      mid-task or delivery stalls shortly after the 1x restart.
 *   B) Client-side — the display layer / native CMTimebase / JS
 *      pacing-pause gets into a bad state when crossing the keyframe
 *      threshold with stale timebase/sample state.
 *
 * This probe isolates (A). It drives the WS protocol the same way the
 * app does when crossing the KEYFRAME_MODE_SPEED_THRESHOLD, but with no
 * display layer — so any observed PTS jump or delivery stall is
 * attributable to the NVR, not to our rendering.
 *
 * Phases:
 *   1. Open playback, enter keyframe mode (matches app's 8x). ACK at
 *      750ms cadence (probe-10 calibrated 8x target). Run for
 *      PHASE_1_SECONDS to build up an 8x-like task state on the server.
 *   2. Simulate the app's setSpeed(1) crossing-threshold restart:
 *        - playback/close old task_id
 *        - wait ≤ 500ms for close#response
 *        - new task_id; playback/open at seekFrom = lastPts - 12
 *        - all_frame (not key_frame)
 *        - audio/close
 *   3. ACK every 8th frame (all-frame 1x cadence, like the app). Run
 *      for PHASE_2_SECONDS and observe.
 *
 * Metrics captured in phase 2:
 *   - Inter-arrival gaps (ms) — detects the "plays briefly then freezes"
 *     pattern as a gap > STALL_MS.
 *   - Monotonic PTS check — any sample whose PTS jumps forward by more
 *     than EXPECTED_PTS_STEP_MAX relative to the previous sample is
 *     flagged as a server-side skip.
 *   - Delta between the very first phase-2 PTS and seekFrom — server
 *     honoring our seek should yield ≈ 0.
 *
 * If we see a 34s PTS jump or a long stall mid-phase-2, the server is
 * the bug source. If phase 2 is smooth and monotonic, the 34s skip is
 * client-side (display layer / CMTimebase / pacing) and this probe
 * rules out the server.
 */
import WebSocket from "ws";
import {
  loadCredentials,
  login,
  pickChannelId,
  sleep,
  writeResult,
  watchdog,
} from "./harness";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL } from "../../shfl";

const PHASE_1_SECONDS = 10;
const PHASE_2_SECONDS = 20;
const ACK_GAP_MS_PHASE1 = 750; // 8x at 2s GOP (probe 10)
/** Rewind cushion. Defaults to the app's 12s. Override via
 *  PROBE_REWIND_SEC to test the effect of smaller rewinds on the
 *  phase-2 burst. */
const UPGRADE_REWIND_SECONDS = Number(process.env.PROBE_REWIND_SEC ?? 12);
/** Minimum gap between ACKs in phase 2 — mirrors
 *  ACK_GAP_MS_AT_1X / speed from PlaybackConnection.schedulePacedAck.
 *  At 1x that's 100ms (the current app value). Override via
 *  PROBE_PHASE2_ACK_GAP_MS to sweep other gaps. */
const PHASE2_MIN_ACK_GAP_MS = Number(process.env.PROBE_PHASE2_ACK_GAP_MS ?? 100);
const STALL_MS = 2000; // treat inter-arrival gap > this as a stall
const EXPECTED_PTS_STEP_MAX_SEC = 2.5; // 2s GOP + slop; any bigger = "skip"
const WATCHDOG_MS = (PHASE_1_SECONDS + PHASE_2_SECONDS + 30) * 1000;

const FILETIME_UNIX_OFFSET_SEC = 11644473600;

function ptsToUnixSec(pts: number): number {
  return pts / 10_000_000 - FILETIME_UNIX_OFFSET_SEC;
}

function unixToUtcTimeStr(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}:000`
  );
}

function randomU32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

type Phase = "phase1-keyframe" | "phase2-allframe";

interface FrameRecord {
  phase: Phase;
  arrivalWallMs: number; // since phase start
  ptsUnixSec: number;
  seq: number;
  frameType: number;
  isKeyFrame: boolean;
}

async function runProbe() {
  watchdog(WATCHDOG_MS);

  const creds = loadCredentials();
  const session = await login(creds);
  console.log(`login ok: sessionId=${session.sessionId.slice(0, 8)} in ${session.loginMs}ms`);

  const channelId = await pickChannelId(session, creds);
  console.log(`channel: ${channelId.slice(1, 9)}`);

  // Wide range so the 1x phase doesn't run off the end.
  const now = Math.floor(Date.now() / 1000);
  const range = { start: now - 7200, end: now - 60 };
  console.log(
    `playback range: ${unixToUtcTimeStr(range.start)} .. ${unixToUtcTimeStr(range.end)}`,
  );

  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let phase: Phase = "phase1-keyframe";
  let taskId = generateTaskId();
  const frames: FrameRecord[] = [];
  let phaseStartWall = 0;
  let phase1LastPtsUnix: number | null = null;
  let phase2SeekFromUnix: number | null = null;
  let phase2TaskOpenedAtMs: number | null = null;
  let phase1FrameCount = 0;
  let phase2FrameCount = 0;
  let ackCount = 0;
  let pendingAckSeq: number | null = null;
  let ackTimer: NodeJS.Timeout | null = null;
  // Phase-2 all-frame-mode ack counter: ack every 8th frame.
  let phase2FrameOrdinal = 0;
  let lastPhase2AckWall = 0;
  let pendingPhase2Seq: number | null = null;
  let phase2AckDelayTimer: NodeJS.Timeout | null = null;

  function schedulePhase2DelayedAck(delayMs: number): void {
    if (phase2AckDelayTimer) return;
    phase2AckDelayTimer = setTimeout(() => {
      phase2AckDelayTimer = null;
      if (pendingPhase2Seq !== null && ws.readyState === WebSocket.OPEN) {
        sendAck(pendingPhase2Seq);
        lastPhase2AckWall = Date.now();
        pendingPhase2Seq = null;
        ackCount++;
      }
    }, delayMs);
  }
  let createConnectionReceived = false;
  let transitionInitiated = false;

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString("utf-8");
      handleText(text);
      return;
    }
    let chunk: Uint8Array;
    if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (Buffer.isBuffer(data)) chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (Array.isArray(data)) chunk = new Uint8Array(Buffer.concat(data));
    else return;

    try {
      const wsFrame = parseWSFrame(chunk);
      const shfl = parseSHFL(wsFrame.payload);
      if (!((shfl.frameType === 0 || shfl.frameType === 4) && shfl.payload.byteLength > 0)) return;

      const nowWall = Date.now();
      if (phaseStartWall === 0) phaseStartWall = nowWall;

      const ptsRaw = shfl.timestampLow + shfl.timestampHigh * 0x100000000;
      const ptsUnix = ptsToUnixSec(ptsRaw);

      const record: FrameRecord = {
        phase,
        arrivalWallMs: nowWall - phaseStartWall,
        ptsUnixSec: ptsUnix,
        seq: shfl.seq,
        frameType: shfl.frameType,
        isKeyFrame: !!shfl.isKeyFrame,
      };
      frames.push(record);

      if (phase === "phase1-keyframe") {
        phase1FrameCount++;
        phase1LastPtsUnix = ptsUnix;
        // Paced ACK matching the app's 8x behavior (probe 10).
        if (shfl.seq > 0) pendingAckSeq = shfl.seq;

        if (phase1FrameCount <= 3 || phase1FrameCount % 10 === 0) {
          console.log(`[P1 ${(record.arrivalWallMs / 1000).toFixed(2)}s] #${phase1FrameCount} seq=${shfl.seq} pts=${ptsUnix.toFixed(3)}`);
        }

        // Transition trigger: after PHASE_1_SECONDS of keyframe-mode
        // delivery, initiate the speed-change restart.
        const phase1ElapsedMs = nowWall - phaseStartWall;
        if (
          !transitionInitiated &&
          phase1ElapsedMs >= PHASE_1_SECONDS * 1000 &&
          phase1LastPtsUnix !== null
        ) {
          transitionInitiated = true;
          initiatePhase2Transition();
        }
      } else {
        phase2FrameCount++;
        phase2FrameOrdinal++;
        // App semantics in all-frame mode: ACK when seq % 8 === 0 (server
        // ignores non-multiples!), with a minimum gap between ACKs
        // (ACK_GAP_MS_AT_1X / speed = 100ms at 1x).
        if (shfl.seq > 0 && shfl.seq % 8 === 0) {
          const sinceLastAck = Date.now() - lastPhase2AckWall;
          if (sinceLastAck >= PHASE2_MIN_ACK_GAP_MS) {
            sendAck(shfl.seq);
            lastPhase2AckWall = Date.now();
            ackCount++;
          } else {
            pendingPhase2Seq = shfl.seq;
            schedulePhase2DelayedAck(PHASE2_MIN_ACK_GAP_MS - sinceLastAck);
          }
        }

        if (phase2FrameCount <= 10 || phase2FrameCount % 30 === 0) {
          console.log(`[P2 ${(record.arrivalWallMs / 1000).toFixed(2)}s] #${phase2FrameCount} seq=${shfl.seq} pts=${ptsUnix.toFixed(3)} key=${shfl.isKeyFrame ? 1 : 0}`);
        }

        const phase2ElapsedMs = nowWall - phaseStartWall;
        if (phase2ElapsedMs >= PHASE_2_SECONDS * 1000) {
          resolveDone();
        }
      }
    } catch {
      // skip malformed
    }
  });

  function handleText(text: string): void {
    let msg: { url?: string; basic?: { code?: number; msg?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.url?.endsWith("create_connection#response")) {
      createConnectionReceived = true;
      // Phase 1: open + key_frame + audio/close (like the app at 8x).
      sendOpen(taskId, range.start, range.end);
      sendKeyFrame(taskId, unixToUtcTimeStr(range.start));
      sendAudioClose(taskId);
      phaseStartWall = 0; // set on first frame
      console.log(`phase1 (keyframe) opened, ACK gap ${ACK_GAP_MS_PHASE1}ms`);
      startPhase1AckTimer();
      return;
    }
    if (msg.url === "/device/playback/open#response") {
      if (msg.basic?.code && msg.basic.code !== 0) {
        console.error(`playback/open rejected: code=${msg.basic.code} msg=${msg.basic.msg}`);
        resolveDone();
        return;
      }
      if (phase === "phase2-allframe" && phase2TaskOpenedAtMs === null) {
        phase2TaskOpenedAtMs = Date.now();
      }
    }
    if (msg.url === "/device/playback/close#response" && phase === "phase2-allframe" && phase2TaskOpenedAtMs === null) {
      // We saw the close-ack; now send the phase-2 open.
      sendPhase2OpenSequence();
    }
  }

  function startPhase1AckTimer(): void {
    if (ackTimer) return;
    ackTimer = setInterval(() => {
      if (phase !== "phase1-keyframe") return;
      if (pendingAckSeq != null && ws.readyState === WebSocket.OPEN) {
        sendAck(pendingAckSeq);
        pendingAckSeq = null;
        ackCount++;
      }
    }, ACK_GAP_MS_PHASE1);
  }

  function stopPhase1AckTimer(): void {
    if (ackTimer) {
      clearInterval(ackTimer);
      ackTimer = null;
    }
  }

  function initiatePhase2Transition(): void {
    if (phase1LastPtsUnix === null) return;
    stopPhase1AckTimer();
    phase = "phase2-allframe";
    phaseStartWall = 0; // reset on first phase-2 frame
    phase2SeekFromUnix = Math.floor(phase1LastPtsUnix - UPGRADE_REWIND_SECONDS);
    console.log(
      `initiating phase 2: lastPts=${phase1LastPtsUnix.toFixed(3)} seekFrom=${phase2SeekFromUnix} ` +
      `(${unixToUtcTimeStr(phase2SeekFromUnix)})`,
    );
    // Close the old task. The server replies with close#response; that
    // handler then sends the new open (mirrors the app's restart()).
    sendClose(taskId);
    // Rotate task id immediately (matches app: see restart() comment).
    taskId = generateTaskId();
  }

  function sendPhase2OpenSequence(): void {
    if (phase2SeekFromUnix === null) return;
    console.log(`phase2 (all-frame) opening at ${unixToUtcTimeStr(phase2SeekFromUnix)}`);
    sendOpen(taskId, phase2SeekFromUnix, range.end);
    sendAllFrame(taskId, unixToUtcTimeStr(phase2SeekFromUnix));
    sendAudioClose(taskId);
  }

  function sendOpen(tid: string, start: number, end: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      url: "/device/playback/open",
      basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
      data: {
        task_id: tid,
        channel_id: channelId,
        start_time: start,
        end_time: end,
        stream_index: 1,
        type_mask: [
          "manual", "sensor", "avd", "smart_pass_line", "tripwire",
          "perimeter", "smart_aoi_entry", "smart_aoi_leave", "motion",
          "pos", "schedule",
        ],
      },
    }));
  }

  function sendKeyFrame(tid: string, frameTime: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      url: "/device/playback/key_frame",
      basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
      data: { task_id: tid, frame_time: frameTime },
    }));
  }

  function sendAllFrame(tid: string, frameTime: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      url: "/device/playback/all_frame",
      basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
      data: { task_id: tid, frame_time: frameTime },
    }));
  }

  function sendAudioClose(tid: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      url: "/device/playback/audio/close",
      basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
      data: { task_id: tid },
    }));
  }

  function sendClose(tid: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      url: "/device/playback/close",
      basic: { ver: "1.0", id: 2, time: Date.now(), nonce: randomU32() },
      data: { task_id: tid },
    }));
  }

  function sendAck(seq: number): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      url: "/device/playback/refresh_play_index",
      basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
      data: { task_id: taskId, play_frame_index: seq },
    }));
  }

  ws.on("close", () => { resolveDone(); });
  ws.on("error", (err) => { console.error("ws error:", err.message); resolveDone(); });

  await done;
  stopPhase1AckTimer();

  try {
    if (ws.readyState === WebSocket.OPEN) sendClose(taskId);
    ws.close();
  } catch {
    // best-effort
  }
  await sleep(200);

  // --- Analyze phase 2 ---
  const phase2 = frames.filter((f) => f.phase === "phase2-allframe");
  if (phase2.length < 2) {
    console.error(`phase 2 received only ${phase2.length} frames`);
    writeResult("11-playback-speed-transition", {
      phase1Frames: frames.filter((f) => f.phase === "phase1-keyframe").length,
      phase2Frames: phase2.length,
      phase1LastPtsUnix,
      phase2SeekFromUnix,
      verdict: phase2.length === 0 ? "NO_PHASE2_FRAMES" : "INSUFFICIENT_PHASE2_DATA",
      frames,
    });
    return;
  }

  // PTS-step scan: any consecutive pair with a delta > threshold is a
  // server-side skip.
  const skips: { idx: number; prevPts: number; nextPts: number; deltaSec: number; wallGapMs: number }[] = [];
  for (let i = 1; i < phase2.length; i++) {
    const a = phase2[i - 1];
    const b = phase2[i];
    const deltaSec = b.ptsUnixSec - a.ptsUnixSec;
    if (deltaSec > EXPECTED_PTS_STEP_MAX_SEC) {
      skips.push({
        idx: i,
        prevPts: a.ptsUnixSec,
        nextPts: b.ptsUnixSec,
        deltaSec,
        wallGapMs: b.arrivalWallMs - a.arrivalWallMs,
      });
    }
  }

  // Inter-arrival stall scan.
  const stalls: { idx: number; gapMs: number; ptsBefore: number; ptsAfter: number }[] = [];
  for (let i = 1; i < phase2.length; i++) {
    const gap = phase2[i].arrivalWallMs - phase2[i - 1].arrivalWallMs;
    if (gap > STALL_MS) {
      stalls.push({
        idx: i,
        gapMs: gap,
        ptsBefore: phase2[i - 1].ptsUnixSec,
        ptsAfter: phase2[i].ptsUnixSec,
      });
    }
  }

  const firstPhase2Pts = phase2[0].ptsUnixSec;
  const lastPhase2Pts = phase2[phase2.length - 1].ptsUnixSec;
  const phase2WallSec = (phase2[phase2.length - 1].arrivalWallMs - phase2[0].arrivalWallMs) / 1000;
  const phase2PtsSpanSec = lastPhase2Pts - firstPhase2Pts;
  const effectivePhase2Rate = phase2WallSec > 0 ? phase2PtsSpanSec / phase2WallSec : 0;
  const seekOffsetSec =
    phase2SeekFromUnix !== null ? firstPhase2Pts - phase2SeekFromUnix : null;

  const summary = {
    phase1FrameCount,
    phase2FrameCount,
    phase1LastPtsUnix,
    phase2SeekFromUnix,
    seekOffsetSec: seekOffsetSec !== null ? Number(seekOffsetSec.toFixed(3)) : null,
    phase2OpenAckMs:
      phase2TaskOpenedAtMs !== null && phase1LastPtsUnix !== null
        ? phase2TaskOpenedAtMs - (phaseStartWall || phase2TaskOpenedAtMs)
        : null,
    phase2WallSec: Number(phase2WallSec.toFixed(2)),
    phase2PtsSpanSec: Number(phase2PtsSpanSec.toFixed(2)),
    effectivePhase2RateX: Number(effectivePhase2Rate.toFixed(2)),
    skips,
    stalls,
    frames,
  };

  const phase1LastPtsStr = String(phase1LastPtsUnix ?? "N/A");
  console.log(`\n=== phase 1 (keyframe / 8x) summary ===`);
  console.log(`  frames: ${phase1FrameCount}, last PTS ≈ ${phase1LastPtsStr}`);
  console.log(`\n=== phase 2 (all-frame / 1x after restart) summary ===`);
  console.log(`  frames: ${phase2FrameCount}`);
  console.log(`  seekFrom: ${phase2SeekFromUnix} (${unixToUtcTimeStr(phase2SeekFromUnix ?? 0)})`);
  console.log(`  first PTS: ${firstPhase2Pts.toFixed(3)} (offset from seekFrom: ${seekOffsetSec?.toFixed(3)}s)`);
  console.log(`  last PTS: ${lastPhase2Pts.toFixed(3)}`);
  console.log(`  wall: ${phase2WallSec.toFixed(2)}s, PTS span: ${phase2PtsSpanSec.toFixed(2)}s → ${effectivePhase2Rate.toFixed(2)}x effective`);
  console.log(`  skips (PTS step > ${EXPECTED_PTS_STEP_MAX_SEC}s): ${skips.length}`);
  skips.slice(0, 5).forEach((s) => console.log(
    `    @frame ${s.idx}: ${s.prevPts.toFixed(3)} → ${s.nextPts.toFixed(3)} (+${s.deltaSec.toFixed(2)}s PTS in ${s.wallGapMs}ms wall)`,
  ));
  console.log(`  stalls (inter-arrival > ${STALL_MS}ms): ${stalls.length}`);
  stalls.slice(0, 5).forEach((s) => console.log(
    `    @frame ${s.idx}: ${s.gapMs}ms wall; PTS ${s.ptsBefore.toFixed(3)} → ${s.ptsAfter.toFixed(3)}`,
  ));

  const verdict =
    skips.length === 0 && stalls.length === 0
      ? `Server delivers phase-2 continuously and monotonically. 34s skip is NOT server-side — it's client (display layer / pacing / timebase).`
      : skips.length > 0
        ? `Server produced ${skips.length} PTS skip(s) in phase 2 (max ${Math.max(...skips.map((s) => s.deltaSec)).toFixed(1)}s). The 34s skip is at least partly server-side.`
        : `Server produced ${stalls.length} delivery stall(s) but no PTS skips. 'Stuck' likely matches — delivery stops mid-stream.`;

  console.log(`\n${verdict}`);
  writeResult("11-playback-speed-transition", { ...summary, verdict });
}

runProbe().catch((err) => {
  console.error(err);
  process.exit(1);
});
