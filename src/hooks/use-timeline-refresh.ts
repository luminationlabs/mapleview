import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";

import { playbackStore } from "../store/playback-store";
import { todayStr } from "../utils/calendar";

const REFRESH_INTERVAL_MS = 45_000;
const MIN_REFRESH_INTERVAL_MS = 5_000;

/**
 * Keep the Recorded screen's segment data current while it's visible.
 *
 * Three triggers, all funneled through one rate-limited path:
 *  - Tab focus (entering Recorded from another tab, or popping back from
 *    single-cam to grid).
 *  - App foreground (handles the "user was already on Recorded when they
 *    backgrounded" case — useFocusEffect doesn't fire in that case
 *    because the navigator's focus state doesn't change across
 *    AppState transitions).
 *  - Periodic interval while focused (handles long stays).
 *
 * Refresh is gated to `selectedDate === today` — historical days don't
 * grow. Day rollover (midnight passed while `followLiveEdge` was true)
 * triggers `onDayRollover(today)` instead of `refresh`; the screen owns
 * the teardown of yesterday's playback and the re-query for the new day,
 * typically by reusing its existing date-picker handler.
 *
 * `refresh` must perform an in-place refresh and never set
 * `loadingSegments` — the screen's existing init flow handles the
 * cold-load case, and this hook only keeps an already-loaded timeline
 * current. The hook skips while `loadingSegments` is true so an
 * in-flight init isn't raced.
 */
export function useTimelineAutoRefresh(opts: {
  refresh: () => Promise<void> | void;
  onDayRollover: (newDate: string) => void | Promise<void>;
}) {
  const refreshRef = useRef(opts.refresh);
  const rolloverRef = useRef(opts.onDayRollover);
  refreshRef.current = opts.refresh;
  rolloverRef.current = opts.onDayRollover;
  const lastRefreshAtRef = useRef(0);
  const focusedRef = useRef(false);
  // True while a rollover handoff is mid-flight. Single-cam's
  // handleSelectDate is async and doesn't write the new selectedDate
  // until after a network query resolves — without this guard, a
  // second trigger (e.g. AppState 'active' immediately followed by a
  // focus event from a tab toggle) would launch a parallel rollover
  // for the same date.
  const rolloverInFlightRef = useRef(false);
  // True while a refresh callback is mid-flight. Prevents overlapping
  // refreshes when network latency exceeds the interval — without this,
  // a 30s-slow refresh would still let the 45s interval fire a second
  // parallel refresh, doubling NVR query load.
  const refreshInFlightRef = useRef(false);

  const maybeRefresh = useCallback(() => {
    const pb = playbackStore.getState();
    const today = todayStr();

    if (pb.followLiveEdge && pb.selectedDate !== today) {
      if (rolloverInFlightRef.current) return;
      rolloverInFlightRef.current = true;
      // Async IIFE so a synchronous throw inside the rollover handler
      // (e.g., grid's handleSelectDate is sync; a setter or date-math
      // throw would propagate) clears the flag in finally rather than
      // leaking it for the lifetime of the screen.
      void (async () => {
        try {
          await rolloverRef.current(today);
        } catch (err) {
          console.log(
            "[timeline-refresh] rollover error:",
            err instanceof Error ? err.message : err,
          );
        } finally {
          rolloverInFlightRef.current = false;
        }
      })();
      return;
    }

    if (pb.selectedDate !== today) return;
    if (pb.loadingSegments) return;
    if (refreshInFlightRef.current) return;

    const now = Date.now();
    if (now - lastRefreshAtRef.current < MIN_REFRESH_INTERVAL_MS) return;
    lastRefreshAtRef.current = now;
    refreshInFlightRef.current = true;
    void (async () => {
      try {
        await refreshRef.current();
      } catch (err) {
        console.log(
          "[timeline-refresh] refresh error:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        refreshInFlightRef.current = false;
      }
    })();
  }, []);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      maybeRefresh();
      const id = setInterval(maybeRefresh, REFRESH_INTERVAL_MS);
      return () => {
        focusedRef.current = false;
        clearInterval(id);
      };
    }, [maybeRefresh]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && focusedRef.current) {
        maybeRefresh();
      }
    });
    return () => sub.remove();
  }, [maybeRefresh]);
}
