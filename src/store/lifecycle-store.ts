import { createStore } from "zustand/vanilla";

export interface LifecycleState {
  /**
   * Monotonic counter bumped by useAppLifecycle when the app returns to
   * foreground AFTER a background teardown actually fired. Hooks driving
   * video views (use-camera, use-playback) subscribe to this to reset
   * their first-frame state and flush the native display layer so the
   * spinner sits over solid black during the reopen, instead of the
   * last-rendered frame remaining frozen on screen.
   *
   * Only bumps when the 5-second background close timer actually
   * elapsed — quick bounces (Face ID unlock, Control Center) leave
   * streams intact and don't need a reset.
   */
  foregroundEpoch: number;
  bumpForegroundEpoch: () => void;
}

export const lifecycleStore = createStore<LifecycleState>((set) => ({
  foregroundEpoch: 0,
  bumpForegroundEpoch: () =>
    set((s) => ({ foregroundEpoch: s.foregroundEpoch + 1 })),
}));

let _useLifecycleStore: typeof import("zustand").useStore | null = null;

export function useLifecycleStore(): LifecycleState;
export function useLifecycleStore<T>(
  selector: (state: LifecycleState) => T,
): T;
export function useLifecycleStore<T>(
  selector?: (state: LifecycleState) => T,
) {
  if (!_useLifecycleStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useStore } = require("zustand") as typeof import("zustand");
    _useLifecycleStore = useStore;
  }
  const useStore = _useLifecycleStore;
  return selector
    ? useStore(lifecycleStore, selector)
    : useStore(lifecycleStore);
}
