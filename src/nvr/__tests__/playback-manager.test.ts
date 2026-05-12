import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackManager } from "../playback-manager";
import { NVRClient, nvrClient } from "../client";
import {
  MockWebSocket,
  installMockWebSocket,
} from "./helpers/mock-websocket";
import { playbackStore } from "../../store/playback-store";
import { unixToUtcTimeStr } from "../../utils/time";

const MOCK_SESSION = {
  host: "192.168.1.1",
  sessionId: "MOCK-SESSION-001",
  token: "{MOCK-TOKEN}",
  userId: "1",
  userName: "admin",
};

/**
 * Seed cameraSegments in the playbackStore so the manager's per-camera
 * coverage gate sees the test's openAll time as "covered" and actually opens
 * a connection. Without this the gate skips the open (correct production
 * behaviour for a playhead in a gap, but not what these tests exercise).
 */
function seedSegmentsCovering(
  channelIds: string[],
  startUnix: number,
  endUnix: number,
) {
  const pad = 3600;
  // utcTimeStrToUnix parses "YYYY-MM-DD HH:MM:SS" — drop the ":000" suffix
  // unixToUtcTimeStr adds (that suffix is for the all_frame format, not for
  // segment strings from queryChlRecLog).
  const startStr = unixToUtcTimeStr(startUnix - pad).slice(0, 19);
  const endStr = unixToUtcTimeStr(endUnix + pad).slice(0, 19);
  for (const id of channelIds) {
    playbackStore
      .getState()
      .setCameraSegments(id, [
        { recType: "SCHEDULE", startTime: startStr, endTime: endStr, size: 100 },
      ]);
  }
}

// Mock the login module so extra-session creation doesn't make real HTTP calls
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

describe("PlaybackManager", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = installMockWebSocket();
    NVRClient.resetForTesting();
    PlaybackManager.resetForTesting();
    // Seed a primary session on nvrClient so acquirePlaybackSlot returns
    // something — tests don't go through the full connect() handshake.
    nvrClient.primeSessionForTesting(MOCK_SESSION, "192.168.1.1", "admin", "password");
    // Reset segments too — tests rely on each starting with a clean store.
    playbackStore.getState().clearSegments();
  });

  afterEach(() => {
    PlaybackManager.resetForTesting();
    NVRClient.resetForTesting();
    playbackStore.getState().clearSegments();
    cleanup();
  });

  it("is a singleton", () => {
    const a = PlaybackManager.getInstance();
    const b = PlaybackManager.getInstance();
    expect(a).toBe(b);
  });

  it("attach registers a sink", () => {
    const mgr = PlaybackManager.getInstance();
    const sink = vi.fn();
    mgr.attach("{CH-001}", sink);
    expect(mgr.getSink("{CH-001}")).toBe(sink);
  });

  it("detach removes a sink", () => {
    const mgr = PlaybackManager.getInstance();
    const sink = vi.fn();
    mgr.attach("{CH-001}", sink);
    mgr.detach("{CH-001}");
    expect(mgr.getSink("{CH-001}")).toBeNull();
  });

  it("closeAll clears connections but preserves sinks (view-owned)", () => {
    const mgr = PlaybackManager.getInstance();
    const sink1 = vi.fn();
    const sink2 = vi.fn();
    mgr.attach("{CH-001}", sink1);
    mgr.attach("{CH-002}", sink2);
    mgr.closeAll();
    // Sinks persist because they're registered by still-mounted views.
    // If closeAll cleared them, a subsequent openAll's frames would be
    // routed to a no-op sink, leaving the view stuck on its last paint
    // (manifested as "day switch fails to load new day's footage").
    expect(mgr.getSink("{CH-001}")).toBe(sink1);
    expect(mgr.getSink("{CH-002}")).toBe(sink2);
  });

  it("openAll creates connections for each camera", async () => {
    const mgr = PlaybackManager.getInstance();


    const cameras = [
      { channelId: "{CH-001}", name: "Cam 1", status: "online" as const },
      { channelId: "{CH-002}", name: "Cam 2", status: "online" as const },
    ];

    seedSegmentsCovering(
      cameras.map((c) => c.channelId),
      1776060000,
      1776146399,
    );
    mgr.openAll(cameras, 1776060000, 1776146399);

    // First one opens immediately (delay=0), second after 200ms
    // Wait for the async session creation for the first one
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });

    // The first connection should have been opened
    expect(MockWebSocket.instances[0].url).toContain(
      "requestWebsocketConnection",
    );
  });

  it("pauseAll and resumeAll toggle pause state on connections", async () => {
    const mgr = PlaybackManager.getInstance();


    const cameras = [
      { channelId: "{CH-001}", name: "Cam 1", status: "online" as const },
    ];

    seedSegmentsCovering(
      cameras.map((c) => c.channelId),
      1776060000,
      1776146399,
    );
    mgr.openAll(cameras, 1776060000, 1776146399);

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });

    // pauseAll / resumeAll should not throw even when connections exist
    expect(() => mgr.pauseAll()).not.toThrow();
    expect(() => mgr.resumeAll()).not.toThrow();
  });

  it("seekAll sends seek to active connections", async () => {
    const mgr = PlaybackManager.getInstance();


    const cameras = [
      { channelId: "{CH-001}", name: "Cam 1", status: "online" as const },
    ];

    seedSegmentsCovering(
      cameras.map((c) => c.channelId),
      1776060000,
      1776146399,
    );
    mgr.openAll(cameras, 1776060000, 1776146399);

    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    });

    // Make the connection alive
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    mgr.seekAll("2026-04-13 21:07:57:108");

    // Unblock restart()'s close-ack wait — restart() sends `playback/close`
    // first, awaits the #response (up to 500ms), then sends open + all_frame.
    // Simulating the response lets the rest flush immediately.
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "/device/playback/close#response", data: {} }),
    );

    await vi.waitFor(() => {
      const seekMsgs = MockWebSocket.latest!.sentMessages
        .filter((m) => typeof m === "string")
        .map((m) => JSON.parse(m as string))
        .filter((m) => m.url === "/device/playback/all_frame");
      expect(seekMsgs.length).toBe(1);
      expect(seekMsgs[0].data.frame_time).toBe("2026-04-13 21:07:57:108");
    });
  });
});
