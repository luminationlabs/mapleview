import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type DebugLogLevel = "info" | "warn" | "error";

export interface DebugLogEntry {
  id: number;
  timestamp: number;
  level: DebugLogLevel;
  message: string;
}

const MAX_ENTRIES = 500;

interface DebugLogState {
  entries: DebugLogEntry[];
  append: (level: DebugLogLevel, message: string) => void;
  clear: () => void;
}

let nextId = 1;

export const debugLogStore = createStore<DebugLogState>((set) => ({
  entries: [],
  append: (level, message) =>
    set((state) => {
      const entry: DebugLogEntry = {
        id: nextId++,
        timestamp: Date.now(),
        level,
        message,
      };
      const next = [...state.entries, entry];
      if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
      return { entries: next };
    }),
  clear: () => set({ entries: [] }),
}));

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(stringifyArg).join(" ");
}

export const debugLog = {
  info: (...args: unknown[]) =>
    debugLogStore.getState().append("info", formatArgs(args)),
  warn: (...args: unknown[]) =>
    debugLogStore.getState().append("warn", formatArgs(args)),
  error: (...args: unknown[]) =>
    debugLogStore.getState().append("error", formatArgs(args)),
};

let installed = false;

/**
 * Mirror console.log/warn/error into the debug log store so existing
 * logging code shows up in the in-app overlay without rewriting every site.
 * Safe to call multiple times — idempotent.
 *
 * Store updates are deferred via `queueMicrotask` so they don't fire
 * synchronously inside the current render pass. React triggers console
 * warnings during render (key warnings, "cannot update during render",
 * etc.) — a synchronous setState in that path produces the very warning
 * we're trying to log, in an infinite loop hazard.
 */
export function installConsoleInterceptor(): void {
  if (installed) return;
  installed = true;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const deferAppend = (level: DebugLogLevel, message: string) => {
    queueMicrotask(() => {
      debugLogStore.getState().append(level, message);
    });
  };

  console.log = (...args: unknown[]) => {
    deferAppend("info", formatArgs(args));
    originalLog.apply(console, args as never);
  };
  console.warn = (...args: unknown[]) => {
    deferAppend("warn", formatArgs(args));
    originalWarn.apply(console, args as never);
  };
  console.error = (...args: unknown[]) => {
    deferAppend("error", formatArgs(args));
    originalError.apply(console, args as never);
  };
}

export function useDebugLog(): DebugLogState;
export function useDebugLog<T>(selector: (s: DebugLogState) => T): T;
export function useDebugLog<T>(selector?: (s: DebugLogState) => T): T | DebugLogState {
  const effective = (selector ?? ((s: DebugLogState) => s)) as (
    s: DebugLogState,
  ) => T;
  return useStore(debugLogStore, effective);
}
