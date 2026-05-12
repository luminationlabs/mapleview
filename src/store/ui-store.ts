import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { kvStorage } from "./kv-storage";
import type { GridLayout } from "../nvr/types";

export interface UIState {
  gridLayout: GridLayout;
  viewMode: "grid" | "list";
  debugMode: boolean;
  /** Single-cam Recorded view: when true, the main playback stream opens
   *  at the NVR's original recording resolution (stream_index 0, typically
   *  4K H.265). When false, the transcoded 704x480 H.264 stream is used
   *  instead (stream_index 1) — smaller bytes, smoother fast-scrub / 4×+.
   *  Automatically forced off at 2×, 4×, and 8× regardless of this setting
   *  — only true 1× playback uses stream 0. HQ is restored on the next
   *  open/restart once speed returns to 1×. */
  hqMode: boolean;
  /** Pro entitlement. StoreKit is the authority; this is a cached flag
   *  refreshed on launch, on purchase, and on restore. Lite (false) caps
   *  the grid layout at 4 tiles. */
  isPro: boolean;
  /** Ephemeral. Mounts the paywall sheet over the current screen when true. */
  paywallOpen: boolean;
  setGridLayout: (layout: GridLayout) => void;
  setViewMode: (mode: "grid" | "list") => void;
  setDebugMode: (enabled: boolean) => void;
  setHqMode: (enabled: boolean) => void;
  setIsPro: (v: boolean) => void;
  setPaywallOpen: (v: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      gridLayout: 4,
      viewMode: "grid" as const,
      debugMode: false,
      hqMode: true,
      isPro: false,
      paywallOpen: false,
      setGridLayout: (layout: GridLayout) => set({ gridLayout: layout }),
      setViewMode: (mode: "grid" | "list") => set({ viewMode: mode }),
      setDebugMode: (enabled: boolean) => set({ debugMode: enabled }),
      setHqMode: (enabled: boolean) => set({ hqMode: enabled }),
      setIsPro: (v: boolean) => set({ isPro: v }),
      setPaywallOpen: (v: boolean) => set({ paywallOpen: v }),
    }),
    {
      name: "nvr-ui-settings",
      storage: createJSONStorage(() => kvStorage),
      partialize: (state) => ({
        gridLayout: state.gridLayout,
        debugMode: state.debugMode,
        hqMode: state.hqMode,
        isPro: state.isPro,
      }),
      version: 2,
      migrate: (persisted, fromVersion) => {
        // v1 used `debugLogVisible` for what v2 calls `debugMode` — this
        // toggle now governs the rate overlay too, not just the log drawer.
        if (fromVersion < 2 && persisted && typeof persisted === "object") {
          const p = persisted as Record<string, unknown>;
          if ("debugLogVisible" in p && !("debugMode" in p)) {
            p.debugMode = p.debugLogVisible;
            delete p.debugLogVisible;
          }
        }
        return persisted as UIState;
      },
    },
  ),
);
