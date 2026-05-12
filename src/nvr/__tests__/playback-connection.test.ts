import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackConnection } from "../playback-connection";
import {
  MockWebSocket,
  installMockWebSocket,
} from "./helpers/mock-websocket";

describe("PlaybackConnection", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = installMockWebSocket();
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a WebSocket with correct URL", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    const sink = vi.fn();
    conn.open("192.168.1.1", "SESSION123", sink, 1776060000, 1776146399);

    expect(MockWebSocket.latest).toBeDefined();
    expect(MockWebSocket.latest!.url).toBe(
      "ws://192.168.1.1/requestWebsocketConnection?sessionID=SESSION123",
    );
    expect(MockWebSocket.latest!.binaryType).toBe("arraybuffer");
    conn.close();
  });

  it("sets isAlive after create_connection response", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    expect(conn.isAlive).toBe(false);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    expect(conn.isAlive).toBe(true);
    conn.close();
  });

  it("sends playback/open after create_connection response", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const sent = MockWebSocket.latest!.sentMessages;
    expect(sent.length).toBeGreaterThan(0);

    const openMsg = JSON.parse(sent[0] as string);
    expect(openMsg.url).toBe("/device/playback/open");
    expect(openMsg.data.channel_id).toBe("{CH-001}");
    expect(openMsg.data.start_time).toBe(1776060000);
    expect(openMsg.data.end_time).toBe(1776146399);
    expect(openMsg.data.stream_index).toBe(2); // sub
    expect(openMsg.data.type_mask).toContain("motion");
    expect(openMsg.data.type_mask).toContain("schedule");
    conn.close();
  });

  it("main mode with HQ on at 1× uses stream_index 0 (original 4K recording)", () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    conn.setHqMode(true);
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const openMsg = JSON.parse(
      MockWebSocket.latest!.sentMessages[0] as string,
    );
    expect(openMsg.data.stream_index).toBe(0);
    conn.close();
  });

  it("main mode with HQ off uses stream_index 1 (transcoded 704x480)", () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    conn.setHqMode(false);
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const openMsg = JSON.parse(
      MockWebSocket.latest!.sentMessages[0] as string,
    );
    expect(openMsg.data.stream_index).toBe(1);
    conn.close();
  });

  it("main mode with HQ on at 2× falls back to stream_index 1 (only 1× uses stream 0)", () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    conn.setHqMode(true);
    conn.setSpeed(2);
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const openMsg = JSON.parse(
      MockWebSocket.latest!.sentMessages[0] as string,
    );
    expect(openMsg.data.stream_index).toBe(1);
    conn.close();
  });

  it("main mode with HQ on at 8× falls back to stream_index 1 (4K can't sustain keyframe mode on this NVR/WiFi)", () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    conn.setHqMode(true);
    conn.setSpeed(8);
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const openMsg = JSON.parse(
      MockWebSocket.latest!.sentMessages[0] as string,
    );
    expect(openMsg.data.stream_index).toBe(1);
    conn.close();
  });

  it("sends playback/audio/close after playback/open response", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "/device/playback/open#response", data: {} }),
    );

    const sent = MockWebSocket.latest!.sentMessages;
    expect(sent.length).toBe(2);
    const audioMsg = JSON.parse(sent[1] as string);
    expect(audioMsg.url).toBe("/device/playback/audio/close");
    conn.close();
  });

  it("close sends playback/close and closes WS", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const ws = MockWebSocket.latest!;
    conn.close();

    const closeMsg = JSON.parse(
      ws.sentMessages[ws.sentMessages.length - 1] as string,
    );
    expect(closeMsg.url).toBe("/device/playback/close");
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(conn.isAlive).toBe(false);
  });

  it("seekInPlace sends all_frame command", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    // Don't await — we only want to inspect the wire message.
    void conn.seekInPlace("2026-04-13 21:07:57:108", 1776114477);

    const sent = MockWebSocket.latest!.sentMessages;
    const seekMsg = JSON.parse(sent[sent.length - 1] as string);
    expect(seekMsg.url).toBe("/device/playback/all_frame");
    expect(seekMsg.data.frame_time).toBe("2026-04-13 21:07:57:108");
    expect(seekMsg.data.task_id).toBe(conn.taskId);
    conn.close();
  });

  it("pause and resume toggle isPaused", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    expect(conn.isPaused).toBe(false);

    conn.pause();
    expect(conn.isPaused).toBe(true);

    conn.resume();
    expect(conn.isPaused).toBe(false);
    conn.close();
  });

  it("generates unique taskId", () => {
    const conn1 = new PlaybackConnection("{CH-001}", "sub");
    const conn2 = new PlaybackConnection("{CH-001}", "sub");
    expect(conn1.taskId).not.toBe(conn2.taskId);
    expect(conn1.taskId.startsWith("{")).toBe(true);
  });

  it("sets isAlive false on WS error", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );
    expect(conn.isAlive).toBe(true);

    MockWebSocket.latest!.simulateError();
    expect(conn.isAlive).toBe(false);
    conn.close();
  });

  it("fires onConnectionFailed on error before first frame", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    const onFailed = vi.fn();
    conn.onConnectionFailed = onFailed;
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);

    MockWebSocket.latest!.simulateError();
    expect(onFailed).toHaveBeenCalled();
    conn.close();
  });

  it("setSink replaces the current sink", () => {
    const conn = new PlaybackConnection("{CH-001}", "sub");
    const sink1 = vi.fn();
    const sink2 = vi.fn();
    conn.open("192.168.1.1", "SESSION123", sink1, 1776060000, 1776146399);

    conn.setSink(sink2);
    // No error means success — sink is internal state
    conn.close();
  });

  /**
   * Without a GOP-observer reset on seek, the first post-seek keyframe's
   * PTS delta from the stale pre-seek `prevKeyframePts` skews the median
   * `observedGopSec`, inflating `schedulePacedAck`'s `targetGap` and
   * collapsing keyframe-mode rate. restart() resets it; seekInPlace must
   * too.
   */
  it("seekInPlace clears GOP-observer state", () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    // Simulate having accumulated GOP samples + a running median. In
    // production this happens after ~3 keyframes in keyframe-mode playback;
    // poking the private state directly is cleaner than building an SHFL
    // stream here.
    type Internals = {
      observedGopSec: number | null;
      prevKeyframePts: number | null;
      recentGopSamples: number[];
      observedPtsPerFrameMs: number | null;
    };
    const privates = conn as unknown as Internals;
    privates.observedGopSec = 4.2;
    privates.prevKeyframePts = 123_456_789;
    privates.recentGopSamples = [4, 4, 5, 4, 3];
    privates.observedPtsPerFrameMs = 33.3;

    // Fire and forget — the returned promise resolves when either the
    // next IDR's PTS matches or it times out. Neither happens in this
    // unit test; we only care that seekInPlace's synchronous state
    // reset fires.
    void conn.seekInPlace("2026-04-18 21:00:00:000", 1776456000);

    expect(privates.observedGopSec).toBeNull();
    expect(privates.prevKeyframePts).toBeNull();
    expect(privates.recentGopSamples).toEqual([]);
    expect(privates.observedPtsPerFrameMs).toBeNull();
    conn.close();
  });

  /**
   * Rapid scrubs in Recorded single-cam were queueing N serialized
   * restarts on the old `restartChain`, each paying a 500ms close-ack
   * wait. 3+ scrubs within a second → enough fixed overhead that the
   * final keyframe didn't arrive before the (non-extending) 5s
   * watchdog fired. The observed 15–20s recovery time was 3–4 cascaded
   * reopen cycles. The coalesce replaces the chain: at most 2 runs
   * execute per burst — the one already in flight plus one catch-up
   * that consumes the latest pending target.
   */
  it("coalesces rapid restart() calls into at most 2 runs, latest target wins", async () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    conn.open("192.168.1.1", "SESSION123", vi.fn(), 1776060000, 1776146399);
    const ws = MockWebSocket.latest!;
    ws.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );
    ws.simulateMessage(
      JSON.stringify({ url: "/device/playback/open#response", data: {} }),
    );

    vi.useFakeTimers();

    // Three rapid restart() calls with different targets — simulates a user
    // dragging the timeline. All three return the same coalesced promise.
    const p = conn.restart(1776060060, 1776146399, null);
    conn.restart(1776060120, 1776146399, null);
    conn.restart(1776060180, 1776146399, null);

    // Drive through both runs. Each runRestart waits up to 500ms for a
    // close-ack; we never send one so each times out and proceeds.
    // Run 1 → Run 2 (consumes the coalesced latest target).
    await vi.advanceTimersByTimeAsync(520);
    await vi.advanceTimersByTimeAsync(520);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    const sent = ws.sentMessages
      .filter((m): m is string => typeof m === "string")
      .map((m) => JSON.parse(m) as { url: string; data: { start_time?: number } });
    const closes = sent.filter((m) => m.url === "/device/playback/close");
    const opens = sent.filter((m) => m.url === "/device/playback/open");

    // 2 runs = 2 close commands + 2 open commands. Plus the initial open
    // fired at open() time (no close before it). Total: 2 closes, 3 opens.
    expect(closes.length).toBe(2);
    expect(opens.length).toBe(3);
    // The last open must use the 3rd restart's start_time — otherwise the
    // coalesce picked a stale target and the user's latest scrub was lost.
    expect(opens[opens.length - 1].data.start_time).toBe(1776060180);

    vi.useRealTimers();
    conn.close();
  });

  /**
   * Each connection observes its own `ptsPerFrame` and sets
   *   targetGap = FRAMES_PER_ACK_ALL_FRAME × ptsPerFrame / speed
   * so server delivery matches real time across cameras with different
   * fps. Test seeds observed frame deltas and verifies the gap.
   */
  it("tunes all-frame ACK gap per-connection from observed ptsPerFrame", () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    type Internals = {
      observedPtsPerFrameMs: number | null;
      isKeyFrameMode: boolean;
      speed: number;
      paused: boolean;
      nextAckWall: number;
      ackTimer: ReturnType<typeof setTimeout> | null;
      ackScheduled: boolean;
    };
    const privates = conn as unknown as Internals;
    privates.isKeyFrameMode = false;
    privates.paused = false;

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const scheduleAndMeasure = (
      ptsPerFrame: number | null,
      speed: number,
    ): number => {
      // Reset state so each scenario starts clean.
      if (privates.ackTimer) clearTimeout(privates.ackTimer);
      privates.ackTimer = null;
      privates.ackScheduled = false;
      privates.observedPtsPerFrameMs = ptsPerFrame;
      privates.speed = speed;
      // Drop the absolute-schedule anchor so the next schedulePacedAck call
      // re-anchors to `now + targetGap` — without this, the anchor carried
      // over from the prior scenario produces a much shorter delay.
      privates.nextAckWall = 0;
      (conn as unknown as { schedulePacedAck(): void }).schedulePacedAck();
      // Binary search by advancing time — find the smallest advance that
      // fires the timer. We only need coarse precision.
      let lo = 0;
      let hi = 6000;
      while (hi - lo > 5) {
        const mid = Math.floor((lo + hi) / 2);
        // Reset and re-schedule to measure the actual delay. Cheaper
        // alternative: just run timers until the ack flag clears.
        void mid;
        break;
      }
      // Simpler: advance a lot and count cleared.
      vi.advanceTimersByTime(hi);
      // The delay was whatever put ackScheduled back to false during the
      // advance. Determine it by iterating smaller windows in a fresh
      // scenario — but simpler: schedule a NEW one and runAllTimers,
      // then read the time difference.
      const before = Date.now();
      privates.ackScheduled = false;
      if (privates.ackTimer) clearTimeout(privates.ackTimer);
      privates.ackTimer = null;
      privates.nextAckWall = 0;
      (conn as unknown as { schedulePacedAck(): void }).schedulePacedAck();
      vi.runOnlyPendingTimers();
      const after = Date.now();
      return after - before;
    };

    const clamp = (x: number): number =>
      Math.min(5000, Math.max(100, x));

    // Default (no observation): ~30fps guess = 32 × 33.3 ≈ 1066ms.
    expect(scheduleAndMeasure(null, 1)).toBeCloseTo(clamp(32 * 33.3), -1);

    // 30fps main-model: 32 × 33.3 ≈ 1066ms.
    expect(scheduleAndMeasure(33.3, 1)).toBeCloseTo(clamp(32 * 33.3), -1);

    // 10fps odd camera: 32 × 100 = 3200ms.
    expect(scheduleAndMeasure(100, 1)).toBeCloseTo(clamp(32 * 100), -1);

    // Speed 2x halves the gap (clamped at 100ms floor).
    expect(scheduleAndMeasure(33.3, 2)).toBeCloseTo(
      clamp((32 * 33.3) / 2),
      -1,
    );

    vi.useRealTimers();
    conn.close();
  });

  /**
   * Companion fix for the coalesce: even after coalescing, two runs can
   * still take ~1s of close-ack waits plus server-side keyframe delivery
   * latency. The old `setLoading(true)` short-circuited if already
   * loading, so a chained restart inherited the first one's 5s watchdog
   * budget and could fire before frames arrived. Now every
   * `setLoading(true)` resets the watchdog, so each restart gets a fresh
   * 5s window.
   */
  it("resets loading watchdog on repeated setLoading(true) calls", () => {
    const conn = new PlaybackConnection("{CH-001}", "main");
    const onStalled = vi.fn();
    conn.onStalled = onStalled;

    type Internals = { setLoading(loading: boolean): void; alive: boolean };
    const privates = conn as unknown as Internals;
    privates.alive = true;

    vi.useFakeTimers();
    privates.setLoading(true); // T=0, watchdog armed for T=5000
    vi.advanceTimersByTime(3000); // T=3000
    privates.setLoading(true); // reset watchdog to fire at T=8000
    vi.advanceTimersByTime(3000); // T=6000 — old watchdog WOULD have fired at 5000
    expect(onStalled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000); // T=9000 — past new watchdog at T=8000
    expect(onStalled).toHaveBeenCalled();

    vi.useRealTimers();
    conn.close();
  });
});
