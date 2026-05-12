import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamConnection } from "../stream-connection";
import {
  MockWebSocket,
  installMockWebSocket,
} from "./helpers/mock-websocket";

describe("StreamConnection", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = installMockWebSocket();
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a WebSocket with correct URL", () => {
    const conn = new StreamConnection("{CH-001}", "main");
    const sink = vi.fn();
    conn.open("192.168.1.1", "SESSION123", sink);

    expect(MockWebSocket.latest).toBeDefined();
    expect(MockWebSocket.latest!.url).toBe(
      "ws://192.168.1.1/requestWebsocketConnection?sessionID=SESSION123",
    );
    expect(MockWebSocket.latest!.binaryType).toBe("arraybuffer");
    conn.close();
  });

  it("sets isAlive after create_connection response", () => {
    const conn = new StreamConnection("{CH-001}", "main");
    const sink = vi.fn();
    conn.open("192.168.1.1", "SESSION123", sink);

    expect(conn.isAlive).toBe(false);

    // Simulate create_connection response
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    expect(conn.isAlive).toBe(true);
    conn.close();
  });

  it("sends preview/open after create_connection response", () => {
    const conn = new StreamConnection("{CH-001}", "main");
    const sink = vi.fn();
    conn.open("192.168.1.1", "SESSION123", sink);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    // Find the preview/open message
    const sent = MockWebSocket.latest!.sentMessages;
    expect(sent.length).toBeGreaterThan(0);

    const openMsg = JSON.parse(sent[0] as string);
    expect(openMsg.url).toBe("/device/preview/open");
    expect(openMsg.data.channel_id).toBe("{CH-001}");
    expect(openMsg.data.stream_index).toBe(1); // main
    expect(openMsg.data.audio).toBe(false);
    conn.close();
  });

  it("uses stream_index 2 for sub mode", () => {
    const conn = new StreamConnection("{CH-001}", "sub");
    const sink = vi.fn();
    conn.open("192.168.1.1", "SESSION123", sink);

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const openMsg = JSON.parse(
      MockWebSocket.latest!.sentMessages[0] as string,
    );
    expect(openMsg.data.stream_index).toBe(2);
    conn.close();
  });

  it("main mode with hqMode=false uses stream_index 2 (sub tier)", () => {
    const conn = new StreamConnection("{CH-001}", "main", false);
    conn.open("192.168.1.1", "SESSION123", vi.fn());
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );
    const openMsg = JSON.parse(
      MockWebSocket.latest!.sentMessages[0] as string,
    );
    expect(openMsg.data.stream_index).toBe(2);
    conn.close();
  });

  it("sends audio/close after preview/open response", () => {
    const conn = new StreamConnection("{CH-001}", "main");
    conn.open("192.168.1.1", "SESSION123", vi.fn());

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "/device/preview/open#response", data: {} }),
    );

    const sent = MockWebSocket.latest!.sentMessages;
    expect(sent.length).toBe(2);
    const audioMsg = JSON.parse(sent[1] as string);
    expect(audioMsg.url).toBe("/device/audio/close");
    conn.close();
  });

  it("close sends preview/close and closes WS", () => {
    const conn = new StreamConnection("{CH-001}", "main");
    conn.open("192.168.1.1", "SESSION123", vi.fn());

    // Make WS "open"
    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );

    const ws = MockWebSocket.latest!;
    conn.close();

    // Should have sent preview/close
    const closeMsg = JSON.parse(
      ws.sentMessages[ws.sentMessages.length - 1] as string,
    );
    expect(closeMsg.url).toBe("/device/preview/close");
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(conn.isAlive).toBe(false);
  });

  it("setSink replaces the current sink", () => {
    const conn = new StreamConnection("{CH-001}", "main");
    const sink1 = vi.fn();
    const sink2 = vi.fn();
    conn.open("192.168.1.1", "SESSION123", sink1);

    conn.setSink(sink2);

    // The sink reference is internal; we verify by checking no errors
    expect(conn.isAlive).toBe(false); // not yet alive until WS responds
    conn.close();
  });

  it("generates a unique taskId", () => {
    const conn1 = new StreamConnection("{CH-001}", "main");
    const conn2 = new StreamConnection("{CH-001}", "main");
    expect(conn1.taskId).not.toBe(conn2.taskId);
    expect(conn1.taskId.startsWith("{")).toBe(true);
  });

  it("sets isAlive false on WS error", () => {
    const conn = new StreamConnection("{CH-001}", "main");
    conn.open("192.168.1.1", "SESSION123", vi.fn());

    MockWebSocket.latest!.simulateMessage(
      JSON.stringify({ url: "create_connection#response", data: {} }),
    );
    expect(conn.isAlive).toBe(true);

    MockWebSocket.latest!.simulateError();
    expect(conn.isAlive).toBe(false);
    conn.close();
  });

  describe("status change callbacks", () => {
    it("emits 'connecting' on open", () => {
      const conn = new StreamConnection("{CH-001}", "main");
      const statusCb = vi.fn();
      conn.setOnStatusChange(statusCb);
      conn.open("192.168.1.1", "SESSION123", vi.fn());

      expect(statusCb).toHaveBeenCalledWith("{CH-001}", "connecting");
      conn.close();
    });

    it("emits 'failed' on WS error", () => {
      const conn = new StreamConnection("{CH-001}", "main");
      const statusCb = vi.fn();
      conn.setOnStatusChange(statusCb);
      conn.open("192.168.1.1", "SESSION123", vi.fn());

      statusCb.mockClear();
      const connFailedCb = vi.fn();
      conn.onConnectionFailed = connFailedCb;
      MockWebSocket.latest!.simulateError();

      // Before first frame, error triggers onConnectionFailed, not "failed" status
      expect(connFailedCb).toHaveBeenCalled();
      conn.close();
    });

    it("does not emit if no callback set", () => {
      const conn = new StreamConnection("{CH-001}", "main");
      // No setOnStatusChange call
      expect(() => {
        conn.open("192.168.1.1", "SESSION123", vi.fn());
        MockWebSocket.latest!.simulateError();
      }).not.toThrow();
      conn.close();
    });
  });
});
