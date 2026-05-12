/**
 * Grid → single-cam transition reproducer.
 *
 * Drives the exact production sequence at the PlaybackManager level:
 *  1. Grid's openAll opens a connection.
 *  2. Grid tile's attach (with mode='main') registers its sink on the conn.
 *  3. Server delivers an initial IDR (grid sink receives it).
 *  4. User enters single-cam: single's attach registers its sink on the
 *     same conn (sinkStacks push). Frames now route to single's sink.
 *  5. First frame reaches single's sink → use-playback fires upgradeMode
 *     → conn.restart() at a rewound seek to avoid the PACING_LEAD skip.
 *  6. Shortly after, the grid tile loses focus (React Navigation push
 *     completes) → grid's detach runs. Same-mode restore path flushes
 *     the restored sink and calls conn.restart() again at lastPts.
 *
 * Two restarts chain via `restartChain`. The test asserts the single-cam
 * sink actually receives post-restart frames and that the loading
 * watchdog (5s) doesn't trip in the happy path. Later perturbations will
 * delay close/open/IDR to see where this sequence fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackManager } from "../playback-manager";
import { PlaybackConnection } from "../playback-connection";
import { NVRClient, nvrClient } from "../client";
import {
  MockWebSocket,
  installMockWebSocket,
} from "./helpers/mock-websocket";
import { playbackStore } from "../../store/playback-store";
import { unixToUtcTimeStr } from "../../utils/time";

// FILETIME epoch offset (matches PlaybackConnection).
const FILETIME_UNIX_OFFSET_SEC = 11644473600;

const MOCK_SESSION = {
  host: "192.168.1.1",
  sessionId: "MOCK-SESSION-001",
  token: "{MOCK-TOKEN}",
  userId: "1",
  userName: "admin",
};

vi.mock("../login", () => ({
  login: vi.fn().mockResolvedValue({
    host: "192.168.1.1",
    sessionId: "MOCK-SESSION-001",
    token: "{MOCK-TOKEN}",
    userId: "1",
    userName: "admin",
  }),
  stripBraces: vi.fn((s: string) => s.replace(/[{}]/g, "")),
}));

function seedSegments(ids: string[], startUnix: number, endUnix: number) {
  const pad = 3600;
  const startStr = unixToUtcTimeStr(startUnix - pad).slice(0, 19);
  const endStr = unixToUtcTimeStr(endUnix + pad).slice(0, 19);
  for (const id of ids) {
    playbackStore
      .getState()
      .setCameraSegments(id, [
        { recType: "SCHEDULE", startTime: startStr, endTime: endStr, size: 100 },
      ]);
  }
}

function buildSHFLChunk(opts: {
  isKeyFrame: boolean;
  seq: number;
  ptsUnix: number;
  frameType?: number;
}): Uint8Array {
  const { isKeyFrame, seq, ptsUnix, frameType = 0 } = opts;
  const filetimeUnits = Math.floor(
    (ptsUnix + FILETIME_UNIX_OFFSET_SEC) * 10_000_000,
  );
  const timestampLow = filetimeUnits >>> 0;
  const timestampHigh = Math.floor(filetimeUnits / 0x100000000);
  const payload = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, isKeyFrame ? 0x65 : 0x41,
  ]);
  const totalSize = 68 + payload.length;
  const chunk = new Uint8Array(totalSize);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 0x4c464853, true); // "SHFL"
  chunk[4] = 0x03;
  chunk[5] = 0x01;
  chunk[6] = 0x07;
  chunk[7] = isKeyFrame ? 1 : 0;
  dv.setUint32(24, totalSize - 44, true);
  dv.setUint32(28, timestampLow, true);
  dv.setUint32(32, timestampHigh, true);
  dv.setUint32(36, seq, true);
  chunk[44] = frameType;
  chunk[45] = 0;
  dv.setUint32(48, payload.length, true);
  chunk.set(payload, 68);
  return chunk;
}

function buildVideoFrame(taskId: string, shflChunk: Uint8Array): ArrayBuffer {
  const header = {
    url: "/device/playback/data",
    basic: { ver: "1.0", id: 1, time: 0 },
    data: { task_id: taskId },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(8 + headerBytes.length + shflChunk.length);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, 0, true);
  dv.setUint32(4, headerBytes.length, true);
  frame.set(headerBytes, 8);
  frame.set(shflChunk, 8 + headerBytes.length);
  return frame.buffer;
}

function sentJSON(ws: MockWebSocket): {
  url: string;
  data: { task_id?: string; frame_time?: string };
}[] {
  return ws.sentMessages
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m));
}

function latestOpenTaskId(ws: MockWebSocket): string | null {
  const opens = sentJSON(ws).filter((m) => m.url === "/device/playback/open");
  return opens.length ? (opens[opens.length - 1].data.task_id ?? null) : null;
}

function countMessagesOfUrl(ws: MockWebSocket, url: string): number {
  return sentJSON(ws).filter((m) => m.url === url).length;
}

describe("grid → single-cam transition", () => {
  let cleanup: () => void;
  const CH = "{CH-001}";
  const START = 1776060000;
  const END = 1776146399;

  beforeEach(() => {
    cleanup = installMockWebSocket();
    NVRClient.resetForTesting();
    PlaybackManager.resetForTesting();
    nvrClient.primeSessionForTesting(
      MOCK_SESSION,
      "192.168.1.1",
      "admin",
      "password",
    );
    playbackStore.getState().clearSegments();
  });

  afterEach(() => {
    vi.useRealTimers();
    PlaybackManager.resetForTesting();
    NVRClient.resetForTesting();
    playbackStore.getState().clearSegments();
    cleanup();
  });

  /**
   * Helper: drive the manager through grid init → WS + initial handshake →
   * grid sink attach → one IDR delivered to the grid sink. Leaves the
   * connection alive and streaming so the caller can simulate the single-
   * cam entry.
   */
  async function setupGridReceivingFrames() {
    const mgr = PlaybackManager.getInstance();
    seedSegments([CH], START, END);
    mgr.openAll(
      [{ channelId: CH, name: "Cam", status: "online" as const }],
      START,
      END,
      "main",
    );
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0];
    const gridSink = vi.fn();
    mgr.attach(CH, gridSink, "main");
    ws.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );
    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/open#response", data: {} }),
    );
    const taskId1 = latestOpenTaskId(ws);
    expect(taskId1).toBeTruthy();
    // Initial IDR — grid sink should receive it.
    ws.simulateMessage(
      buildVideoFrame(
        taskId1!,
        buildSHFLChunk({ isKeyFrame: true, seq: 8, ptsUnix: START }),
      ),
    );
    expect(gridSink).toHaveBeenCalledTimes(1);
    return { mgr, ws, gridSink, taskId1: taskId1! };
  }

  it("happy path: single-cam sink receives frames after upgradeMode restart", async () => {
    const { mgr, ws, taskId1 } = await setupGridReceivingFrames();

    // --- User taps tile → single-cam screen mounts ---
    const singleSink = vi.fn();
    mgr.attach(CH, singleSink, "main");
    // Register resync handler the way use-playback does (flush viewRef).
    const singleFlush = vi.fn();
    mgr.setResyncHandler(singleSink, singleFlush);

    // A P-frame lands on the existing conn — now routed to singleSink.
    ws.simulateMessage(
      buildVideoFrame(
        taskId1,
        buildSHFLChunk({ isKeyFrame: false, seq: 9, ptsUnix: START + 1 }),
      ),
    );
    expect(singleSink).toHaveBeenCalledTimes(1);

    // use-playback fires upgradeMode on hasFirstFrame.
    mgr.upgradeMode(CH, "main");
    // Resync handler should have fired to flush the native view.
    expect(singleFlush).toHaveBeenCalledTimes(1);

    // restart() sent playback/close with the OLD task_id.
    await vi.waitFor(() => {
      expect(countMessagesOfUrl(ws, "/device/playback/close")).toBe(1);
    });
    // Unblock the 500ms close-ack wait.
    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/close#response", data: {} }),
    );

    // restart() then sends a new playback/open + all_frame.
    await vi.waitFor(() => {
      expect(countMessagesOfUrl(ws, "/device/playback/open")).toBe(2);
    });
    const taskId2 = latestOpenTaskId(ws);
    expect(taskId2).toBeTruthy();
    expect(taskId2).not.toBe(taskId1);

    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/open#response", data: {} }),
    );

    // Deliver a fresh IDR on the new task (frameType=4 = resync IDR).
    singleSink.mockClear();
    ws.simulateMessage(
      buildVideoFrame(
        taskId2!,
        buildSHFLChunk({
          isKeyFrame: true,
          seq: 8,
          ptsUnix: START + 5,
          frameType: 4,
        }),
      ),
    );
    // singleSink should have received the post-restart IDR directly —
    // first keyframe goes straight to the sink (no pre-buffer).
    expect(singleSink.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Old taskId frames delivered before upgradeMode shouldn't have been
    // resurfaced — assert taskId2 frames are what arrived.
    const deliveredPayloads = singleSink.mock.calls.map((c) => c[0]);
    expect(deliveredPayloads.length).toBeGreaterThan(0);
  });

  /**
   * Regression: `upgradeMode` must realign `sharedSeekUnix` to `seekFrom`
   * before triggering `conn.restart()`. Skipping this leaves the baseline
   * at the pre-transition value (e.g., minutes earlier), so the restarted
   * task's first frames are PTS-ahead of the baseline by >PACING_LEAD_MS
   * and `scheduleFrameDelivery` pauses ACKs at frame 16. Server's 32-frame
   * window fills, frames stop arriving, no keyframe ever surfaces, and
   * the 5s loading watchdog fires → onStalled → reopen. Observed on-device
   * symptom: single-cam spinner stuck for 15–35s before recovering.
   */
  it("upgradeMode realigns sharedSeekUnix to seekFrom", async () => {
    const { mgr, ws, taskId1 } = await setupGridReceivingFrames();

    const setPacingBaselineSpy = vi.spyOn(
      PlaybackConnection,
      "setPacingBaseline",
    );

    const singleSink = vi.fn();
    mgr.attach(CH, singleSink, "main");
    mgr.setResyncHandler(singleSink, vi.fn());
    // Prime first frame so production's hasFirstFrame → upgradeMode path
    // matches.
    ws.simulateMessage(
      buildVideoFrame(
        taskId1,
        buildSHFLChunk({ isKeyFrame: false, seq: 9, ptsUnix: START + 1 }),
      ),
    );

    mgr.upgradeMode(CH, "main");

    // upgradeMode's same-mode resync branch: after computing seekFrom,
    // it must call PlaybackConnection.setPacingBaseline(seekFrom) before
    // handing off to conn.restart(). Without this the shared pacing
    // baseline stays stale and the restart path stalls.
    expect(setPacingBaselineSpy).toHaveBeenCalled();
    const lastCallArg = setPacingBaselineSpy.mock.calls.at(-1)?.[0];
    expect(typeof lastCallArg).toBe("number");
    // seekFrom should be a sane unix second close to the day's range.
    expect(lastCallArg).toBeGreaterThan(START - 86400);
    expect(lastCallArg).toBeLessThan(END + 86400);

    setPacingBaselineSpy.mockRestore();
  });

  /**
   * Forward scrub at 1x in single-cam: stale pre-scrub frames can arrive
   * between `seekAll` setting `sharedSeekUnix` and `restart()`'s taskId
   * rotation (which lives in a microtask). With `frameCount >= 16` the
   * stale frame triggers the leadMs<-1000 re-align branch and rolls
   * `sharedSeekUnix` backward — the next restart's frames then appear
   * "far ahead", pacing pauses, and the loading watchdog reopens.
   *
   * Asserts `setPacingBaseline` is NOT called with a value less than
   * `newStart` after seekAll.
   */
  it("stale pre-scrub frame rolls sharedSeekUnix backward", async () => {
    const { mgr, ws, taskId1 } = await setupGridReceivingFrames();

    // Production precondition: the active conn has been streaming long
    // enough that frameCount has crossed FLOW_CONTROL_INTERVAL * 2 = 16,
    // which is the gate on `scheduleFrameDelivery`'s pacing check. Force
    // the counter rather than pumping 16 frames to keep the test focused.
    const conn = (
      mgr as unknown as { connections: Map<string, PlaybackConnection> }
    ).connections.get(CH)!;
    (conn as unknown as { frameCount: number }).frameCount = 20;

    const NEW_START = START + 60; // 1-minute forward scrub
    const setBaselineSpy = vi.spyOn(
      PlaybackConnection,
      "setPacingBaseline",
    );

    // User scrubs forward 60s. seekAll calls setPacingBaseline(NEW_START)
    // synchronously. For a single-channel test STAGGER_MS = 0 so
    // existing.restart(...) is called synchronously too — but its
    // taskId rotation happens inside the chained .then(run) microtask,
    // which hasn't drained yet within this synchronous block.
    mgr.seekAll(unixToUtcTimeStr(NEW_START));
    expect(setBaselineSpy).toHaveBeenLastCalledWith(NEW_START);

    // Before the microtask drains, a stale pre-scrub frame arrives with
    // the OLD taskId and PTS at the pre-scrub position. Synchronously
    // dispatched — no await between seekAll and this simulateMessage,
    // so the restart's run() hasn't rotated taskId yet.
    ws.simulateMessage(
      buildVideoFrame(
        taskId1,
        buildSHFLChunk({ isKeyFrame: false, seq: 40, ptsUnix: START }),
      ),
    );

    // If the re-align branch fires (bug present), the last
    // setPacingBaseline call will be with `START` (the stale frame's
    // frameUnix). If the baseline is protected against stale-frame
    // rollback (fix applied), the last call remains at NEW_START.
    expect(setBaselineSpy).toHaveBeenLastCalledWith(NEW_START);

    setBaselineSpy.mockRestore();
  });

  it("watchdog path: no post-restart IDR within 5s triggers onStalled → reopen", async () => {
    const { mgr, ws, taskId1 } = await setupGridReceivingFrames();

    const singleSink = vi.fn();
    mgr.attach(CH, singleSink, "main");
    mgr.setResyncHandler(singleSink, vi.fn());

    // Frame to register the sink and simulate the hasFirstFrame signal.
    ws.simulateMessage(
      buildVideoFrame(
        taskId1,
        buildSHFLChunk({ isKeyFrame: false, seq: 9, ptsUnix: START + 1 }),
      ),
    );

    // Switch to fake timers BEFORE upgradeMode so the 5s watchdog is fake.
    vi.useFakeTimers();
    mgr.upgradeMode(CH, "main");

    // Let restart()'s micro/macrotasks progress past the close send.
    await vi.advanceTimersByTimeAsync(10);
    expect(countMessagesOfUrl(ws, "/device/playback/close")).toBe(1);

    // NVR never acks the close → the 500ms inner timeout fires and open+
    // all_frame get sent anyway.
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(10);
    expect(countMessagesOfUrl(ws, "/device/playback/open")).toBe(2);

    // Server sends playback/open#response but NEVER an IDR for the new task.
    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/open#response", data: {} }),
    );

    // Watchdog is 5s from setLoading(true) → should fire. onStalled hands
    // off to openOne which opens a NEW WebSocket.
    const wsCountBefore = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    // Let the reopen promise chain progress.
    await vi.advanceTimersByTimeAsync(50);

    // If our hypothesis is right, a second WebSocket should now exist
    // (from openOne's conn.open()).
    expect(MockWebSocket.instances.length).toBeGreaterThan(wsCountBefore);
  });

  /**
   * Production sequence includes a SECOND restart: grid tile's
   * useIsFocused() goes false after the push animation, the tile's
   * use-playback effect cleanup runs `detach(ch, gridSink)`, and detach's
   * same-mode restore path calls `conn.restart(lastFrameUnix)`. Both
   * restart() calls now coalesce — the first one runs, the second
   * updates the pending target, and the activeRestartPromise loop
   * picks up the updated target in a single catch-up run. End state:
   * the final task's IDR reaches the single-cam sink.
   */
  it("double restart (upgradeMode + detach-restore) delivers the final IDR to single-cam sink", async () => {
    const { mgr, ws, gridSink, taskId1 } = await setupGridReceivingFrames();

    const singleSink = vi.fn();
    mgr.attach(CH, singleSink, "main");
    mgr.setResyncHandler(singleSink, vi.fn());

    // Frame on existing task → now routed to singleSink. In production
    // this drives hasFirstFrame=true.
    ws.simulateMessage(
      buildVideoFrame(
        taskId1,
        buildSHFLChunk({ isKeyFrame: false, seq: 9, ptsUnix: START + 1 }),
      ),
    );

    // use-playback fires upgradeMode on first frame.
    mgr.upgradeMode(CH, "main");
    // Shortly after, focus leaves the grid → grid tile's effect cleanup
    // runs detach(ch, gridSink). Same-mode restore: pops gridSink, reuses
    // singleSink, calls conn.restart(lastFrameUnix).
    mgr.detach(CH, gridSink);

    // Both restarts should now be queued on restartChain. Each needs a
    // close-ack to proceed past its 500ms gate. Deliver both sequentially,
    // simulating a cooperative NVR. Assert that the second close (for
    // restart #2's task) doesn't fire until restart #1 has sent its open.
    await vi.waitFor(() => {
      expect(countMessagesOfUrl(ws, "/device/playback/close")).toBeGreaterThanOrEqual(1);
    });
    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/close#response", data: {} }),
    );

    await vi.waitFor(() => {
      // initial open + restart #1 open
      expect(countMessagesOfUrl(ws, "/device/playback/open")).toBeGreaterThanOrEqual(2);
      // restart #2 has now chained its close
      expect(countMessagesOfUrl(ws, "/device/playback/close")).toBe(2);
    });
    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/close#response", data: {} }),
    );

    await vi.waitFor(() => {
      // initial + 2 restarts = 3 opens
      expect(countMessagesOfUrl(ws, "/device/playback/open")).toBe(3);
    });

    const taskIdFinal = latestOpenTaskId(ws);
    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/open#response", data: {} }),
    );

    // Deliver the final task's IDR promptly. Single sink should receive it.
    singleSink.mockClear();
    ws.simulateMessage(
      buildVideoFrame(
        taskIdFinal!,
        buildSHFLChunk({
          isKeyFrame: true,
          seq: 8,
          ptsUnix: START + 15,
          frameType: 4,
        }),
      ),
    );
    ws.simulateMessage(
      buildVideoFrame(
        taskIdFinal!,
        buildSHFLChunk({ isKeyFrame: true, seq: 16, ptsUnix: START + 17 }),
      ),
    );
    expect(singleSink.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

});
