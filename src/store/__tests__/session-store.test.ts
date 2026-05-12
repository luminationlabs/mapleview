import { beforeEach, describe, expect, it } from "vitest";
import { sessionStore } from "../session-store";
import type { NvrSession } from "../../nvr/types";

describe("sessionStore", () => {
  beforeEach(() => {
    sessionStore.getState().clearSession();
  });

  const mockSession: NvrSession = {
    host: "192.168.1.1",
    sessionId: "ABC-123",
    token: "{TOKEN-1}",
    userId: "user1",
    userName: "admin",
  };

  it("starts with null/false defaults", () => {
    const state = sessionStore.getState();
    expect(state.host).toBeNull();
    expect(state.sessionId).toBeNull();
    expect(state.connected).toBe(false);
    expect(state.connecting).toBe(false);
    expect(state.error).toBeNull();
  });

  it("setSession populates all fields", () => {
    sessionStore.getState().setSession(mockSession);
    const state = sessionStore.getState();
    expect(state.host).toBe("192.168.1.1");
    expect(state.sessionId).toBe("ABC-123");
    expect(state.token).toBe("{TOKEN-1}");
    expect(state.userId).toBe("user1");
    expect(state.connected).toBe(true);
    expect(state.connecting).toBe(false);
  });

  it("setConnecting updates connecting flag", () => {
    sessionStore.getState().setConnecting(true);
    expect(sessionStore.getState().connecting).toBe(true);

    sessionStore.getState().setConnecting(false);
    expect(sessionStore.getState().connecting).toBe(false);
  });

  it("setError sets error and clears connecting", () => {
    sessionStore.getState().setConnecting(true);
    sessionStore.getState().setError("Network failed");

    const state = sessionStore.getState();
    expect(state.error).toBe("Network failed");
    expect(state.connecting).toBe(false);
  });

  it("setError with null clears error", () => {
    sessionStore.getState().setError("Something");
    sessionStore.getState().setError(null);
    expect(sessionStore.getState().error).toBeNull();
  });

  it("clearSession resets all fields", () => {
    sessionStore.getState().setSession(mockSession);
    sessionStore.getState().clearSession();

    const state = sessionStore.getState();
    expect(state.host).toBeNull();
    expect(state.sessionId).toBeNull();
    expect(state.token).toBeNull();
    expect(state.userId).toBeNull();
    expect(state.connected).toBe(false);
    expect(state.connecting).toBe(false);
    expect(state.error).toBeNull();
    expect(state.reconnecting).toBe(false);
    expect(state.attemptCount).toBe(0);
    expect(state.authFailed).toBe(false);
  });

  it("starts with reconnect/auth defaults", () => {
    const state = sessionStore.getState();
    expect(state.reconnecting).toBe(false);
    expect(state.attemptCount).toBe(0);
    expect(state.authFailed).toBe(false);
  });

  it("setReconnecting updates reconnecting and attemptCount", () => {
    sessionStore.getState().setReconnecting(true, 3);
    const state = sessionStore.getState();
    expect(state.reconnecting).toBe(true);
    expect(state.attemptCount).toBe(3);
  });

  it("setReconnecting without attemptCount preserves existing count", () => {
    sessionStore.getState().setReconnecting(true, 5);
    sessionStore.getState().setReconnecting(false);
    const state = sessionStore.getState();
    expect(state.reconnecting).toBe(false);
    expect(state.attemptCount).toBe(5);
  });

  it("setAuthFailed sets authFailed flag", () => {
    sessionStore.getState().setAuthFailed(true);
    expect(sessionStore.getState().authFailed).toBe(true);

    sessionStore.getState().setAuthFailed(false);
    expect(sessionStore.getState().authFailed).toBe(false);
  });

  it("setSession clears reconnecting and authFailed", () => {
    sessionStore.getState().setReconnecting(true, 3);
    sessionStore.getState().setAuthFailed(true);
    sessionStore.getState().setSession(mockSession);

    const state = sessionStore.getState();
    expect(state.reconnecting).toBe(false);
    expect(state.attemptCount).toBe(0);
    expect(state.authFailed).toBe(false);
    expect(state.connected).toBe(true);
  });
});
