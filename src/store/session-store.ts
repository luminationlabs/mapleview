import { createStore } from "zustand/vanilla";
import type { NvrSession } from "../nvr/types";

export interface SessionState {
  host: string | null;
  sessionId: string | null;
  token: string | null;
  userId: string | null;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  reconnecting: boolean;
  attemptCount: number;
  authFailed: boolean;
  setSession: (session: NvrSession) => void;
  setConnecting: (v: boolean) => void;
  setError: (e: string | null) => void;
  setReconnecting: (v: boolean, attemptCount?: number) => void;
  setAuthFailed: (v: boolean) => void;
  clearSession: () => void;
}

export const sessionStore = createStore<SessionState>((set) => ({
  host: null,
  sessionId: null,
  token: null,
  userId: null,
  connected: false,
  connecting: false,
  error: null,
  reconnecting: false,
  attemptCount: 0,
  authFailed: false,
  setSession: (session: NvrSession) =>
    set({
      host: session.host,
      sessionId: session.sessionId,
      token: session.token,
      userId: session.userId,
      connected: true,
      connecting: false,
      reconnecting: false,
      attemptCount: 0,
      error: null,
      authFailed: false,
    }),
  setConnecting: (v: boolean) => set({ connecting: v }),
  setError: (e: string | null) => set({ error: e, connecting: false }),
  setReconnecting: (v: boolean, attemptCount?: number) =>
    set((state) => ({
      reconnecting: v,
      attemptCount: attemptCount ?? state.attemptCount,
    })),
  setAuthFailed: (v: boolean) => set({ authFailed: v }),
  clearSession: () =>
    set({
      host: null,
      sessionId: null,
      token: null,
      userId: null,
      connected: false,
      connecting: false,
      error: null,
      reconnecting: false,
      attemptCount: 0,
      authFailed: false,
    }),
}));

// React hook (lazy import avoids issues in non-React test contexts)
let _useSessionStore: typeof import("zustand").useStore | null = null;

export function useSessionStore(): SessionState;
export function useSessionStore<T>(selector: (state: SessionState) => T): T;
export function useSessionStore<T>(selector?: (state: SessionState) => T) {
  if (!_useSessionStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useStore } = require("zustand") as typeof import("zustand");
    _useSessionStore = useStore;
  }
  const useStore = _useSessionStore;
  return selector
    ? useStore(sessionStore, selector)
    : useStore(sessionStore);
}
