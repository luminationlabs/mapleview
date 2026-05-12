import { createStore } from "zustand/vanilla";
import type { CameraInfo, CameraStatus } from "../nvr/types";

const ORDER_STORAGE_KEY = "nvr-camera-order";

/** Persist ordered channelId array to storage (fire-and-forget). */
function persistOrder(cameras: CameraInfo[]) {
  try {
    // Dynamic import so vanilla store works in non-RN test environments
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { kvStorage } = require("./kv-storage") as typeof import("./kv-storage");
    const ids = cameras.map((c) => c.channelId);
    kvStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Silently ignore in environments where storage is unavailable
  }
}

/** Load saved order from storage. Returns null if none saved. */
export async function loadSavedOrder(): Promise<string[] | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { kvStorage } = require("./kv-storage") as typeof import("./kv-storage");
    const raw = await kvStorage.getItem(ORDER_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    // Ignore
  }
  return null;
}

/** Apply a saved channelId ordering to a camera list. Unknown ids go to end. */
export function applySavedOrder(
  cameras: CameraInfo[],
  savedOrder: string[],
): CameraInfo[] {
  const orderMap = new Map(savedOrder.map((id, i) => [id, i]));
  const sorted = [...cameras].sort((a, b) => {
    const ai = orderMap.get(a.channelId) ?? Number.MAX_SAFE_INTEGER;
    const bi = orderMap.get(b.channelId) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
  return sorted;
}

export interface CameraState {
  cameras: CameraInfo[];
  /** The saved ordering loaded from storage, if any. */
  _savedOrder: string[] | null;
  /**
   * True while the app is recovering from a background → foreground transition
   * (streams closed, re-enumerating, reopening). Used by the UI to show a
   * neutral "Reconnecting…" state instead of per-tile failure overlays or the
   * "No cameras available" empty state.
   */
  reconnecting: boolean;
  setCameras: (cameras: CameraInfo[]) => void;
  updateStatus: (channelId: string, status: CameraStatus) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
  setSavedOrder: (order: string[]) => void;
  setReconnecting: (reconnecting: boolean) => void;
  clear: () => void;
}

export const cameraStore = createStore<CameraState>((set, get) => ({
  cameras: [],
  _savedOrder: null,
  reconnecting: false,
  setCameras: (cameras: CameraInfo[]) => {
    const savedOrder = get()._savedOrder;
    const ordered = savedOrder ? applySavedOrder(cameras, savedOrder) : cameras;
    set({ cameras: ordered });
  },
  updateStatus: (channelId: string, status: CameraStatus) =>
    set((state) => ({
      cameras: state.cameras.map((cam) =>
        cam.channelId === channelId ? { ...cam, status } : cam,
      ),
    })),
  reorder: (fromIndex: number, toIndex: number) =>
    set((state) => {
      const cameras = [...state.cameras];
      if (
        fromIndex < 0 ||
        fromIndex >= cameras.length ||
        toIndex < 0 ||
        toIndex >= cameras.length
      ) {
        return state;
      }
      const [item] = cameras.splice(fromIndex, 1);
      cameras.splice(toIndex, 0, item);
      persistOrder(cameras);
      return { cameras };
    }),
  setSavedOrder: (order: string[]) => set({ _savedOrder: order }),
  setReconnecting: (reconnecting: boolean) => set({ reconnecting }),
  clear: () => set({ cameras: [], _savedOrder: null, reconnecting: false }),
}));

// React hook
let _useCameraStore: typeof import("zustand").useStore | null = null;

export function useCameraStore(): CameraState;
export function useCameraStore<T>(selector: (state: CameraState) => T): T;
export function useCameraStore<T>(selector?: (state: CameraState) => T) {
  if (!_useCameraStore) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useStore } = require("zustand") as typeof import("zustand");
    _useCameraStore = useStore;
  }
  const useStore = _useCameraStore;
  return selector
    ? useStore(cameraStore, selector)
    : useStore(cameraStore);
}
