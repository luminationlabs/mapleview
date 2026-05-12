import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NVRClient } from "../client";
import { sessionStore } from "../../store/session-store";
import { cameraStore } from "../../store/camera-store";
import {
  MockWebSocket,
  installMockWebSocket,
} from "./helpers/mock-websocket";

// Mock login
vi.mock("../login", () => ({
  login: vi.fn().mockResolvedValue({
    host: "192.168.1.1",
    sessionId: "ABC123",
    token: "{TOKEN-1}",
    userId: "user1",
    userName: "admin",
  }),
  stripBraces: vi.fn((s: string) => s.replace(/[{}]/g, "")),
}));

// Mock XML queries
vi.mock("../xml", () => ({
  queryChlsExistRec: vi.fn().mockResolvedValue({
    status: "success",
    content: {
      item: [
        { "@_id": "{CAM-1}", "#text": "Front Door" },
        { "@_id": "{CAM-2}", "#text": "Backyard" },
      ],
    },
  }),
  queryOnlineChlList: vi.fn().mockResolvedValue({
    status: "success",
    content: {
      item: [
        { "@_id": "{CAM-1}" },
        { "@_id": "{CAM-2}" },
      ],
    },
  }),
}));

describe("NVRClient", () => {
  let wsCleanup: () => void;

  beforeEach(() => {
    NVRClient.resetForTesting();
    wsCleanup = installMockWebSocket();
  });

  afterEach(() => {
    NVRClient.resetForTesting();
    wsCleanup();
  });

  it("is a singleton", () => {
    const a = NVRClient.getInstance();
    const b = NVRClient.getInstance();
    expect(a).toBe(b);
  });

  it("resetForTesting creates a new instance", () => {
    const a = NVRClient.getInstance();
    NVRClient.resetForTesting();
    const b = NVRClient.getInstance();
    expect(a).not.toBe(b);
  });

  it("connect sets session store", async () => {
    const client = NVRClient.getInstance();
    await client.connect("192.168.1.1", "admin", "pass");

    const state = sessionStore.getState();
    expect(state.connected).toBe(true);
    expect(state.host).toBe("192.168.1.1");
    expect(state.sessionId).toBe("ABC123");
  });

  it("connect populates camera store", async () => {
    const client = NVRClient.getInstance();
    await client.connect("192.168.1.1", "admin", "pass");

    const cameras = cameraStore.getState().cameras;
    expect(cameras).toHaveLength(2);
    expect(cameras[0].channelId).toBe("{CAM-1}");
    expect(cameras[0].name).toBe("Front Door");
    expect(cameras[0].status).toBe("online");
  });

  it("connect sets error on failure", async () => {
    const { login } = await import("../login");
    vi.mocked(login).mockRejectedValueOnce(new Error("Network error"));

    const client = NVRClient.getInstance();
    await expect(
      client.connect("192.168.1.1", "admin", "pass"),
    ).rejects.toThrow("Network error");

    const state = sessionStore.getState();
    expect(state.error).toBe("Network error");
    expect(state.connected).toBe(false);
  });

  it("isConnected reflects connection state", async () => {
    const client = NVRClient.getInstance();
    expect(client.isConnected).toBe(false);

    await client.connect("192.168.1.1", "admin", "pass");
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it("disconnect clears stores and streams", async () => {
    const client = NVRClient.getInstance();
    await client.connect("192.168.1.1", "admin", "pass");

    // Attach a stream
    const sink = vi.fn();
    client.attach("{CAM-1}", "main", sink);

    client.disconnect();

    expect(sessionStore.getState().connected).toBe(false);
    expect(cameraStore.getState().cameras).toHaveLength(0);
    expect(client.session).toBeNull();
  });

  // Helper to let async scheduleOpen resolve
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("attach creates a StreamConnection", async () => {
    const client = NVRClient.getInstance();
    await client.connect("192.168.1.1", "admin", "pass");

    const sink = vi.fn();
    client.attach("{CAM-1}", "main", sink);
    await tick(); // let async doOpen resolve

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    const ws = MockWebSocket.latest!;
    expect(ws.url).toContain("sessionID=ABC123");

    client.disconnect();
  });

  it("attach reuses alive connections", async () => {
    const client = NVRClient.getInstance();
    await client.connect("192.168.1.1", "admin", "pass");

    const sink1 = vi.fn();
    client.attach("{CAM-1}", "main", sink1);
    await tick();

    // Simulate the connection becoming alive
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const wsCountBefore = MockWebSocket.instances.length;
    const sink2 = vi.fn();
    client.attach("{CAM-1}", "main", sink2);
    await tick();

    // No new WebSocket should be created
    expect(MockWebSocket.instances.length).toBe(wsCountBefore);

    client.disconnect();
  });

  it("detach closes the stream after grace period", async () => {
    const client = NVRClient.getInstance();
    await client.connect("192.168.1.1", "admin", "pass");

    client.attach("{CAM-1}", "main", vi.fn());
    await tick();
    const ws = MockWebSocket.latest!;

    ws.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    client.detach("{CAM-1}", "main");
    // Not closed immediately — grace period
    expect(ws.readyState).not.toBe(MockWebSocket.CLOSED);

    // After grace period, it should be closed
    await new Promise((r) => setTimeout(r, 2000));
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    client.disconnect();
  });

  it("attach silently skips if not connected", () => {
    const client = NVRClient.getInstance();
    // Should not throw — just registers the sink for later
    expect(() => client.attach("{CAM-1}", "main", vi.fn())).not.toThrow();
  });

  describe("concurrent attach distribution (race regression)", () => {
    // These tests override the login mock to hand out unique sessionIds so
    // we can observe distribution across sessions. Restore in afterEach so
    // a failing assertion here doesn't leak state to later tests.
    let restoreLoginMock: (() => void) | null = null;
    afterEach(() => {
      restoreLoginMock?.();
      restoreLoginMock = null;
    });

    async function installDistinctSessionLogin(
      extra?: () => Promise<void>,
    ): Promise<{
      login: ReturnType<typeof vi.fn>;
      state: {
        counter: number;
        concurrentInFlight: number;
        maxConcurrent: number;
        totalStarted: number;
      };
    }> {
      const { login: loginFn } = await import("../login");
      const mockLogin = loginFn as unknown as ReturnType<typeof vi.fn>;
      const originalImpl = mockLogin.getMockImplementation();
      const state = {
        counter: 0,
        concurrentInFlight: 0,
        maxConcurrent: 0,
        totalStarted: 0,
      };
      mockLogin.mockImplementation(async () => {
        state.totalStarted++;
        state.concurrentInFlight++;
        if (state.concurrentInFlight > state.maxConcurrent) {
          state.maxConcurrent = state.concurrentInFlight;
        }
        if (extra) await extra();
        state.concurrentInFlight--;
        return {
          host: "192.168.1.1",
          sessionId: `SESSION-${++state.counter}`,
          token: `{TOKEN-${state.counter}}`,
          userId: `user${state.counter}`,
          userName: "admin",
        };
      });
      restoreLoginMock = () => {
        if (originalImpl) mockLogin.mockImplementation(originalImpl);
        else mockLogin.mockReset();
      };
      return { login: mockLogin, state };
    }

    /**
     * Production cold-launch bug: N cameras attach synchronously, all of
     * their doOpen() microtasks enter `await getAvailableSession()` before
     * any has populated streamSessions. Each sees
     * `streamCountForSession(primary) < 6` and picks primary, causing the
     * 7th+ WS upgrade to hit the NVR's per-session cap (HTTP 400).
     *
     * Fix: `getAvailableSession` reserves a live-slot claim synchronously
     * via `claimLiveSlot` before returning, so concurrent callers see the
     * reserved slots and correctly spill to an extra session.
     *
     * This test attaches 12 channels synchronously and verifies that no
     * single session sees more than 6 WebSockets opened against it.
     * Integration probe 06 verifies the server-side cap itself.
     */
    it("12 concurrent attaches distribute no more than 6 per session", async () => {
      await installDistinctSessionLogin();

      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      // Clear WSes from connect (none here, but be defensive)
      const wsCountBefore = MockWebSocket.instances.length;

      // Fire 12 attaches synchronously — mirrors cold-launch of a 12-camera grid.
      for (let i = 1; i <= 12; i++) {
        const chId = `{CAM-${String(i).padStart(2, "0")}}`;
        client.attach(chId, "sub", vi.fn());
      }

      // Let scheduleOpen microtasks + extra-session login resolve.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 400));
      }

      const opened = MockWebSocket.instances.slice(wsCountBefore);
      // Group opens by their sessionID query parameter.
      const bySession = new Map<string, number>();
      for (const ws of opened) {
        const m = ws.url.match(/sessionID=([^&]+)/);
        const sid = m ? m[1] : "?";
        bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
      }

      // No session should have had more than MAX_STREAMS_PER_SESSION=6 opens.
      for (const [sid, count] of bySession) {
        expect(
          count,
          `session ${sid} received ${count} WS opens (>6 means the race is back)`,
        ).toBeLessThanOrEqual(6);
      }
      // And all 12 channels should have been served (distributed across >=2 sessions).
      const total = [...bySession.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(12);
      expect(bySession.size).toBeGreaterThanOrEqual(2);

      client.disconnect();
    });

    /**
     * Second race, observed after the first fix: on Recorded-tab switch, all
     * live slots are consumed on the primary + first extra. acquirePlaybackSlot
     * fires for 12 channels in parallel. The first caller correctly starts
     * login #N+1 and others piggyback on pendingExtraSessions. But when that
     * login resolves, ~12 awaiters all resume: the first 6 claim slots on the
     * fresh session (now at cap), and awaiters 7+ fall through the post-await
     * cap check and each call startExtraSessionLogin() independently — N
     * logins fire in the same millisecond. The NVR rejects several under
     * load (observed doLogin: status=fail).
     *
     * After the fix, only ONE new login should start per wave of awaiters
     * (subsequent callers piggyback via pendingExtraSessions on their retry).
     */
    it("post-await cap check does not spawn a login per overflow caller", async () => {
      // 200ms login latency so all concurrent logins overlap for observation.
      const { state } = await installDistinctSessionLogin(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });

      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      // Fire enough parallel acquires that at least TWO extra sessions are
      // needed — so after the first extra-session login resolves, a batch
      // of overflow callers all have to start (or share) a SECOND login.
      // 18 acquires at cap=6 ⇒ primary + 2 extras. The "second extra"
      // spawn is where the post-await race manifests.
      const N = 18;
      const slotPromises: Promise<unknown>[] = [];
      for (let i = 0; i < N; i++) {
        slotPromises.push(client.acquirePlaybackSlot());
      }
      const results = await Promise.all(slotPromises);
      const got = results.filter((s) => s != null);
      expect(got.length).toBe(N);

      // The pool should NOT have fired one login per overflow caller. A
      // well-behaved pool needs ceil(18 / 6) = 3 sessions, i.e. the primary
      // login from connect() + 2 extras. Tolerate small jitter.
      // Pre-fix behavior: 5+ concurrent logins at the same moment.
      expect(
        state.maxConcurrent,
        `saw ${state.maxConcurrent} concurrent logins in flight — the post-await cap race is back`,
      ).toBeLessThanOrEqual(2);
      expect(
        state.totalStarted,
        `started ${state.totalStarted} total logins; expected ≤ 3 (primary + 2 extras)`,
      ).toBeLessThanOrEqual(3);

      client.disconnect();
    });

    /**
     * awaitForegroundReady is the gate that playback-manager uses to avoid
     * opening on a stale primary while handleForeground is still validating
     * it. Outside a foreground cycle, it must resolve immediately; during a
     * foreground cycle it must not resolve until enumerateCameras /
     * attemptAuthRecovery has completed.
     */
    it("awaitForegroundReady resolves immediately when not in a foreground cycle", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");
      // Sanity: the default promise is pre-resolved.
      const t0 = Date.now();
      await client.awaitForegroundReady();
      expect(Date.now() - t0).toBeLessThan(20);
      client.disconnect();
    });

    it("awaitForegroundReady blocks playback opens until primary is validated", async () => {
      // Make enumerateCameras slow so handleForeground lingers in its
      // validation phase. Playback opens that await foregroundReady should
      // be blocked until enumerate resolves.
      const xmlMod = await import("../xml");
      const originalQuery = (
        xmlMod.queryChlsExistRec as unknown as ReturnType<typeof vi.fn>
      ).getMockImplementation();
      const originalOnline = (
        xmlMod.queryOnlineChlList as unknown as ReturnType<typeof vi.fn>
      ).getMockImplementation();

      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      // Now slow down enumerateCameras for the foreground path.
      (xmlMod.queryChlsExistRec as unknown as ReturnType<typeof vi.fn>)
        .mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 150));
          return {
            status: "success",
            content: { item: [{ "@_id": "{CAM-1}", "#text": "Front Door" }] },
          };
        });
      (xmlMod.queryOnlineChlList as unknown as ReturnType<typeof vi.fn>)
        .mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { status: "success", content: { item: [{ "@_id": "{CAM-1}" }] } };
        });

      try {
        const t0 = Date.now();
        const fgPromise = client.handleForeground();
        // awaitForegroundReady must not resolve before enumerate completes.
        const gatePromise = client.awaitForegroundReady().then(() => Date.now() - t0);
        const elapsed = await gatePromise;
        await fgPromise;
        expect(
          elapsed,
          "foreground gate should block until enumerate finishes (~150ms)",
        ).toBeGreaterThanOrEqual(100);
      } finally {
        (xmlMod.queryChlsExistRec as unknown as ReturnType<typeof vi.fn>)
          .mockImplementation(originalQuery ?? (() => Promise.resolve({ status: "success", content: { item: [] } })));
        (xmlMod.queryOnlineChlList as unknown as ReturnType<typeof vi.fn>)
          .mockImplementation(originalOnline ?? (() => Promise.resolve({ status: "success", content: { item: [] } })));
        client.disconnect();
      }
    });

    /**
     * Foreground scenario: after a background transition, BOTH live-stream
     * reopens and playback-manager reopens race. 12 live + 12 playback = 24
     * streams firing concurrently via their respective schedulers.
     *
     * Verify that both session pools (liveClaims + playbackClaims) share
     * the accounting correctly and no session ever exceeds cap=6.
     */
    it("mixed 12 live + 12 playback across four sessions never exceeds cap", async () => {
      await installDistinctSessionLogin(async () => {
        // Simulate login latency so cap checks happen against evolving state.
        await new Promise((r) => setTimeout(r, 50));
      });

      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      // Fire 12 playback slot acquires and 12 live attaches concurrently.
      const pendingPlayback = [];
      for (let i = 0; i < 12; i++) {
        pendingPlayback.push(client.acquirePlaybackSlot());
      }
      const wsCountBefore = MockWebSocket.instances.length;
      for (let i = 1; i <= 12; i++) {
        const chId = `{LIVE-${String(i).padStart(2, "0")}}`;
        client.attach(chId, "sub", vi.fn());
      }

      // Wait for logins + opens to settle.
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 400));
      }

      const playbackSessions = (await Promise.all(pendingPlayback)).filter(
        (s) => s != null,
      );
      expect(playbackSessions.length).toBe(12);

      const liveWs = MockWebSocket.instances.slice(wsCountBefore);
      const perSession = new Map<string, number>();
      // Count live WSes per session.
      for (const ws of liveWs) {
        const m = ws.url.match(/sessionID=([^&]+)/);
        const sid = m ? m[1] : "?";
        perSession.set(sid, (perSession.get(sid) ?? 0) + 1);
      }
      // Add playback claims per session.
      for (const s of playbackSessions as { sessionId: string }[]) {
        perSession.set(s.sessionId, (perSession.get(s.sessionId) ?? 0) + 1);
      }
      for (const [sid, count] of perSession) {
        expect(
          count,
          `session ${sid} received ${count} claims (live + playback); cap is 6`,
        ).toBeLessThanOrEqual(6);
      }
      // Total should be 24 (12 live + 12 playback).
      const total = [...perSession.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(24);

      client.disconnect();
    });
  });

  describe("reconnect", () => {
    it("startReconnect sets reconnecting state", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      // Simulate disconnect
      client.disconnect();

      // Reconnect needs stored creds, set them via connect first
      await client.connect("192.168.1.1", "admin", "pass");
      sessionStore.getState().clearSession();
      client.startReconnect();

      const state = sessionStore.getState();
      expect(state.reconnecting).toBe(true);
    });

    it("stopReconnect clears reconnecting state", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");
      sessionStore.getState().clearSession();

      client.startReconnect();
      client.stopReconnect();

      const state = sessionStore.getState();
      expect(state.reconnecting).toBe(false);
      expect(state.attemptCount).toBe(0);
    });

    it("retryNow attempts reconnect immediately", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      // retryNow should succeed since login mock always resolves
      await client.retryNow();

      const state = sessionStore.getState();
      expect(state.connected).toBe(true);
    });

    it("schedules reconnect attempts with backoff", async () => {
      vi.useFakeTimers();
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      // Make next connect fail then succeed
      const { login: loginFn } = await import("../login");
      vi.mocked(loginFn)
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          host: "192.168.1.1",
          sessionId: "ABC123",
          token: "{TOKEN-1}",
          userId: "user1",
          userName: "admin",
        });

      sessionStore.getState().clearSession();
      client.startReconnect();

      // First attempt at 1s
      expect(sessionStore.getState().attemptCount).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);

      // Should have attempted and failed, scheduling next at 2s
      expect(sessionStore.getState().attemptCount).toBe(2);
      await vi.advanceTimersByTimeAsync(2000);

      // Should have succeeded
      expect(sessionStore.getState().connected).toBe(true);
      expect(sessionStore.getState().reconnecting).toBe(false);

      vi.useRealTimers();
    });
  });

  describe("closeAllStreams", () => {
    it("closes streams but preserves sink registry for reopening", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      const sink = vi.fn();
      client.attach("{CAM-1}", "main", sink);
      await tick();

      MockWebSocket.latest!.simulateMessage(
        JSON.stringify({ url: "create_connection#response", data: {} }),
      );

      client.closeAllStreams();

      // Streams are closed
      expect(MockWebSocket.latest!.readyState).toBe(MockWebSocket.CLOSED);

      // But we can still retryNow and streams will be re-opened
      await client.retryNow();
      // New WebSocket should be created for the stream
      const newWs = MockWebSocket.latest!;
      expect(newWs.url).toContain("sessionID=ABC123");
    });
  });

  describe("auth recovery", () => {
    it("attemptAuthRecovery succeeds with stored creds", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      const result = await client.attemptAuthRecovery();
      expect(result).toBe(true);
      expect(sessionStore.getState().connected).toBe(true);
    });

    it("attemptAuthRecovery returns false without flagging authFailed when no creds available", async () => {
      const client = NVRClient.getInstance();
      // Don't connect first - no stored creds. A fresh-install "no creds"
      // state isn't a login failure; the root layout shows onboarding
      // directly in that case, and flagging authFailed would stack a
      // second "login expired" modal on top of the first onboarding view.
      const result = await client.attemptAuthRecovery();
      expect(result).toBe(false);
      expect(sessionStore.getState().authFailed).toBe(false);
    });

    it("attemptAuthRecovery uses credential loader", async () => {
      const client = NVRClient.getInstance();
      client.setCredentialLoader(async () => ({
        host: "192.168.1.1",
        username: "admin",
        password: "pass",
      }));

      const result = await client.attemptAuthRecovery();
      expect(result).toBe(true);
      expect(sessionStore.getState().connected).toBe(true);
    });

    it("attemptAuthRecovery sets authFailed on real NVR auth rejection", async () => {
      const { login: loginFn } = await import("../login");

      const client = NVRClient.getInstance();
      // Connect first to store credentials
      await client.connect("192.168.1.1", "admin", "pass");

      // doLogin:-prefixed errors are how login() reports an actual NVR
      // password rejection (see src/nvr/login.ts). One rejection is enough
      // — the loop bails immediately on auth-class errors.
      vi.mocked(loginFn).mockRejectedValueOnce(new Error("doLogin: password error"));
      const result = await client.attemptAuthRecovery();
      expect(result).toBe(false);
      expect(sessionStore.getState().authFailed).toBe(true);
    });

    it("attemptAuthRecovery does NOT set authFailed on transport errors", async () => {
      const { login: loginFn } = await import("../login");

      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");
      sessionStore.getState().setAuthFailed(false);

      // "Network request failed" is what XHR onerror throws — transport,
      // not auth. We do NOT want this to pop the onboarding modal; instead
      // attemptAuthRecovery should hand off to the reconnect backoff loop.
      // All 3 retries reject so the loop exhausts.
      vi.mocked(loginFn)
        .mockRejectedValueOnce(new Error("Network request failed"))
        .mockRejectedValueOnce(new Error("Network request failed"))
        .mockRejectedValueOnce(new Error("Network request failed"));
      const result = await client.attemptAuthRecovery();
      expect(result).toBe(false);
      expect(sessionStore.getState().authFailed).toBe(false);
    });
  });

  describe("stream status changes", () => {
    it("attach sets up onStatusChange that updates camera store on connect", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      const sink = vi.fn();
      client.attach("{CAM-1}", "sub", sink);
      await tick(); // let async doOpen resolve

      // The onStatusChange should fire "connecting" when WS opens
      const cam = cameraStore
        .getState()
        .cameras.find((c) => c.channelId === "{CAM-1}");
      expect(cam?.status).toBe("connecting");
    });
  });

  // These tests exercise stream-registry behaviors most at risk during
  // refactors that touch the streams + sinks + retry-timer + detach-timer
  // state. They use real timers (matching the existing test style) and
  // short waits (~2s) so the suite stays fast.
  describe("stream registry behaviors", () => {
    it("re-attach within the detach grace period reuses the WS", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      client.attach("{CAM-1}", "main", vi.fn());
      await tick();
      const ws = MockWebSocket.latest!;
      ws.simulateMessage(
        JSON.stringify({ url: "create_connection#response", data: {} }),
      );
      const wsCountBefore = MockWebSocket.instances.length;

      // Schedule a detach but re-attach before the grace period (1.5s) elapses.
      client.detach("{CAM-1}", "main");
      await new Promise((r) => setTimeout(r, 200));
      client.attach("{CAM-1}", "main", vi.fn());
      await tick();

      // No new WS should have been opened — same connection survives the grace.
      expect(MockWebSocket.instances.length).toBe(wsCountBefore);
      // Wait past where the grace timer would have fired and confirm the WS
      // is still open — the detach was actually cancelled, not just deferred.
      await new Promise((r) => setTimeout(r, 1600));
      expect(ws.readyState).toBe(MockWebSocket.OPEN);

      client.disconnect();
    });

    it("pre-frame WS close triggers a retry within the retry window", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      client.attach("{CAM-1}", "main", vi.fn());
      await tick();
      const firstWs = MockWebSocket.latest!;
      const wsCountBefore = MockWebSocket.instances.length;

      // Close before any frame arrives — this is the pre-frame WS close
      // that triggers onConnectionFailed → scheduleOpen retry.
      firstWs.close();

      // Retry delay is 1000ms + jitter up to 800ms ⇒ wait 2.2s.
      await new Promise((r) => setTimeout(r, 2200));

      expect(
        MockWebSocket.instances.length,
        "expected a retry WS upgrade after pre-frame close",
      ).toBeGreaterThan(wsCountBefore);

      client.disconnect();
    });

    it("closeAllStreams cancels pending retry timers", async () => {
      const client = NVRClient.getInstance();
      await client.connect("192.168.1.1", "admin", "pass");

      client.attach("{CAM-1}", "main", vi.fn());
      await tick();
      const firstWs = MockWebSocket.latest!;

      // Trigger a retry — this schedules a setTimeout inside scheduleOpen.
      firstWs.close();
      // Without giving the retry time to fire, tear everything down.
      // closeAllStreams must cancel the timer so it doesn't race the next
      // reopen wave.
      client.closeAllStreams();

      const wsCountAfterClose = MockWebSocket.instances.length;

      // Wait past the maximum retry window (1000 + 800 jitter = 1.8s, plus
      // headroom). If the timer wasn't cancelled, it'd fire here and open
      // a new WS to the (now-cleared) primary.
      await new Promise((r) => setTimeout(r, 2200));

      expect(
        MockWebSocket.instances.length,
        "retry fired after closeAllStreams — pending timer was not cancelled",
      ).toBe(wsCountAfterClose);

      client.disconnect();
    });

    it("liveHqModeChanged reopens main streams but leaves sub streams alone", async () => {
      const client = NVRClient.getInstance();
      // Install an HQ provider so resolveStreamIndex on main streams
      // depends on it (otherwise main always lands on the same stream
      // index and there's nothing to test).
      client.setHqModeProvider(() => true);
      await client.connect("192.168.1.1", "admin", "pass");

      // Attach one main stream and one sub stream.
      client.attach("{CAM-1}", "main", vi.fn());
      await tick();
      const mainWs = MockWebSocket.latest!;
      mainWs.simulateMessage(
        JSON.stringify({ url: "create_connection#response", data: {} }),
      );

      client.attach("{CAM-2}", "sub", vi.fn());
      await tick();
      const subWs = MockWebSocket.latest!;
      subWs.simulateMessage(
        JSON.stringify({ url: "create_connection#response", data: {} }),
      );

      const wsCountBefore = MockWebSocket.instances.length;

      // Flip HQ — should tear down + reopen the main stream only.
      client.liveHqModeChanged();
      await tick();

      // Main was closed and reopened.
      expect(mainWs.readyState).toBe(MockWebSocket.CLOSED);
      // Sub stream untouched.
      expect(subWs.readyState).toBe(MockWebSocket.OPEN);
      // Exactly one new WS opened (for main).
      expect(MockWebSocket.instances.length).toBe(wsCountBefore + 1);

      client.disconnect();
    });
  });
});
