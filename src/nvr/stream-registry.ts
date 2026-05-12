import { StreamConnection } from "./stream-connection";
import type { FrameSink, NvrSession, StreamKey, StreamMode } from "./types";
import type { SessionPool } from "./session-pool";
import type { RecoveryClusterer } from "./recovery-clusterer";
import { cameraStore } from "../store/camera-store";
import { debugLog } from "../utils/debug-log";

export interface StreamRegistryDeps {
  sessions: SessionPool;
  recovery: RecoveryClusterer;
  /** Read the current openEpoch (bumped externally on bg/fg/teardown).
   *  scheduleOpen captures it at start and self-aborts at each await
   *  checkpoint if it's advanced. */
  getOpenEpoch(): number;
  /** Read the user's HQ preference at open time. */
  getHqMode(): boolean;
  /** Called from attach() when there's no primary session — gives the
   *  host a chance to startReconnect. The host should no-op if a
   *  reconnect / connect is already in flight. */
  kickReconnectIfStranded(): void;
}

/**
 * Owns the live-stream lifecycle: per-key StreamConnection instances,
 * the sink registry that drives reconnect/foreground reopen, the detach
 * grace timers, and the retry timer chain. Intentionally separate from
 * SessionPool — sessions are just inventory, this registry actually
 * opens WSes against them.
 */
export class StreamRegistry {
  private static readonly DETACH_GRACE_MS = 1500;

  private streams = new Map<StreamKey, StreamConnection>();
  private streamSessions = new Map<StreamKey, NvrSession>();
  /** Sinks for keys that may not have a live connection right now —
   *  reopenAll() and foreground recovery iterate this to restore. */
  private sinkRegistry = new Map<StreamKey, FrameSink>();
  /** Pending detach timers. Re-attach within the grace window cancels
   *  the timer (grid↔list toggle reuse). */
  private detachTimers = new Map<StreamKey, ReturnType<typeof setTimeout>>();
  /** Pending retry setTimeouts from onConnectionFailed. Tracked so
   *  closeAll() can cancel them — otherwise a retry queued before a
   *  background cycle fires post-foreground and races the reopen wave. */
  private pendingRetryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: StreamRegistryDeps) {}

  // -------- Diagnostics --------

  get size(): number {
    return this.streams.size;
  }

  /** Number of registered sinks — including those without a live stream
   *  right now (e.g. mid-detach, dead connection awaiting reopen). */
  get sinkCount(): number {
    return this.sinkRegistry.size;
  }

  get pendingRetryCount(): number {
    return this.pendingRetryTimers.size;
  }

  /** Number of active live streams using `session`. SessionPool calls
   *  this for the unified live + playback capacity check. */
  countActiveLiveStreams(session: NvrSession): number {
    let count = 0;
    for (const s of this.streamSessions.values()) {
      if (s.sessionId === session.sessionId) count++;
    }
    return count;
  }

  // -------- Public lifecycle --------

  /** Attach a frame sink to a channel stream. Reuses the existing
   *  connection when alive; otherwise schedules a fresh open. */
  attach(channelId: string, mode: StreamMode, sink: FrameSink): void {
    const key: StreamKey = `${channelId}:${mode}`;

    // Cancel any pending detach (grid↔list toggle reuse).
    const pendingDetach = this.detachTimers.get(key);
    if (pendingDetach) {
      clearTimeout(pendingDetach);
      this.detachTimers.delete(key);
    }

    // Always register the sink so reconnect/foreground can restore.
    this.sinkRegistry.set(key, sink);

    const existing = this.streams.get(key);
    if (existing && existing.isAlive) {
      existing.setSink(sink);
      return;
    }

    cameraStore.getState().updateStatus(channelId, "connecting");

    if (existing) {
      existing.close();
    }

    if (!this.deps.sessions.primary) {
      // No session — sinkRegistry entry means reopenAll will pick this
      // up. Ensure there's an active recovery path so the tile isn't
      // stuck on a spinner with no trigger.
      this.deps.kickReconnectIfStranded();
      return;
    }

    this.scheduleOpen(key, channelId, mode, sink);
  }

  /** Detach with a grace period. Re-attach within DETACH_GRACE_MS
   *  reuses the connection without close/reopen. */
  detach(channelId: string, mode: StreamMode): void {
    const key: StreamKey = `${channelId}:${mode}`;

    // Clear the sink immediately so frames don't reach an unmounted view.
    const conn = this.streams.get(key);
    if (conn) {
      conn.setSink(() => {});
    }

    const timer = setTimeout(() => {
      this.detachTimers.delete(key);
      const c = this.streams.get(key);
      if (c) {
        c.close();
        this.streams.delete(key);
        this.streamSessions.delete(key);
      }
      this.sinkRegistry.delete(key);
    }, StreamRegistry.DETACH_GRACE_MS);

    this.detachTimers.set(key, timer);
  }

  /** Close all live streams + cancel pending timers. Used by
   *  NVRClient.closeAllStreams (background) and disconnect.
   *
   *  - `clearSinks: false` (default) preserves sinkRegistry so
   *    reopenAll can restore on foreground.
   *  - `clearSinks: true` drops everything — used by disconnect.
   */
  closeAll({ clearSinks = false }: { clearSinks?: boolean } = {}): void {
    for (const conn of this.streams.values()) {
      conn.close();
    }
    this.streams.clear();
    this.streamSessions.clear();
    for (const timer of this.detachTimers.values()) clearTimeout(timer);
    this.detachTimers.clear();
    for (const t of this.pendingRetryTimers) clearTimeout(t);
    this.pendingRetryTimers.clear();
    if (clearSinks) this.sinkRegistry.clear();
  }

  /** Cancel pending retry timers without closing live streams.
   *  runHandleForeground calls this defensively in case a stray retry
   *  was scheduled outside the normal closeAllStreams path. */
  cancelPendingRetries(): void {
    for (const t of this.pendingRetryTimers) clearTimeout(t);
    this.pendingRetryTimers.clear();
  }

  /** Re-open streams for every registered sink that doesn't already
   *  have a live connection. Called after foreground / reconnect. */
  reopenAll(): void {
    if (!this.deps.sessions.primary) return;

    for (const [key, sink] of this.sinkRegistry.entries()) {
      const existing = this.streams.get(key);
      if (existing?.isAlive) continue;

      if (existing) {
        existing.close();
        this.streams.delete(key);
      }

      const [channelId, mode] = key.split(":") as [string, StreamMode];
      this.scheduleOpen(key, channelId, mode, sink);
    }
  }

  /** Reopen every active main-mode stream so a flipped HQ pref takes
   *  effect on the wire. stream_index is fixed at open, so there's no
   *  in-place swap. Sub streams unaffected. */
  liveHqModeChanged(): void {
    const keys: StreamKey[] = [];
    for (const [key, conn] of this.streams) {
      if (conn.mode !== "main") continue;
      // Skip mid-detach streams — the grace timer would tear our reopen
      // down ~1.5s later. User leaving single-cam is intent we respect.
      if (this.detachTimers.has(key)) continue;
      keys.push(key);
    }
    for (const key of keys) {
      const [channelId] = key.split(":") as [string, StreamMode];
      const sink = this.sinkRegistry.get(key);
      if (!sink) continue;
      const conn = this.streams.get(key);
      if (conn) {
        conn.setOnStatusChange(null);
        conn.onConnectionFailed = null;
        conn.onStalled = null;
        conn.close();
      }
      this.streams.delete(key);
      this.streamSessions.delete(key);
      // attach() would set this; we bypass attach here to keep sinkRegistry.
      cameraStore.getState().updateStatus(channelId, "connecting");
      this.scheduleOpen(key, channelId, "main", sink);
    }
  }

  // -------- Internal --------

  /** Open a stream connection. All opens fire in parallel — 6
   *  simultaneous WS upgrades on one session are reliably accepted at
   *  cap. Session chosen by getAvailableSession at open time. */
  private scheduleOpen(
    key: StreamKey,
    channelId: string,
    mode: StreamMode,
    sink: FrameSink,
    retryCount = 0,
  ): void {
    const epoch = this.deps.getOpenEpoch();
    const doOpen = async () => {
      if (this.deps.getOpenEpoch() !== epoch) return;
      if (!this.sinkRegistry.has(key) || !this.deps.sessions.primary) return;

      // getAvailableSession reserves a live-slot claim before returning;
      // every exit path that doesn't reach the final streamSessions.set
      // below MUST releaseLiveSlot.
      const session = await this.deps.sessions.getAvailableSession();
      // Re-check state after the await: sink may have detached, client
      // may have disconnected, teardown may have bumped openEpoch.
      if (
        this.deps.getOpenEpoch() !== epoch ||
        !this.sinkRegistry.has(key) ||
        !this.deps.sessions.primary
      ) {
        if (session) this.deps.sessions.releaseLiveSlot(session);
        return;
      }
      if (!session) {
        cameraStore.getState().updateStatus(channelId, "failed");
        return;
      }

      // Displace any existing stream — a retry colliding with a fresh
      // attach can leave orphans that emit "failed" while the new conn
      // is streaming frames.
      const displaced = this.streams.get(key);
      if (displaced) {
        displaced.setOnStatusChange(null);
        displaced.onConnectionFailed = null;
        displaced.onStalled = null;
        displaced.close();
        this.streams.delete(key);
        this.streamSessions.delete(key);
      }

      const hqMode = mode === "main" ? this.deps.getHqMode() : true;
      const conn = new StreamConnection(channelId, mode, hqMode);
      conn.setOnStatusChange((chId, status) => {
        if (this.streams.get(key) !== conn) return;
        cameraStore.getState().updateStatus(chId, status);
      });
      conn.onConnectionFailed = (closeCode?: number) => {
        if (this.streams.get(key) !== conn) return;
        this.streams.delete(key);
        this.streamSessions.delete(key);
        debugLog.warn(
          `[stream-registry] onConnectionFailed ch=${channelId.slice(1, 9)} attempt=${retryCount + 1} code=${closeCode ?? "?"}`,
        );
        // Cluster pre-frame closes — the proxy signal for stale-session
        // HTTP 400 on upgrade. Auto-recovers before per-channel chains exhaust.
        this.deps.recovery.notePreFrameClose();
        if (retryCount < 3 && this.sinkRegistry.has(key) && this.deps.sessions.primary) {
          const jitter = Math.random() * 800;
          const retryDelay = Math.round(1000 + retryCount * 1000 + jitter);
          debugLog.warn(
            `[stream-registry] retry ch=${channelId} attempt=${retryCount + 1}/3 in ${retryDelay}ms`,
          );
          const timer = setTimeout(() => {
            this.pendingRetryTimers.delete(timer);
            // Skip if another attempt already produced a live stream.
            const current = this.streams.get(key);
            if (current && current.isAlive) {
              debugLog.info(
                `[stream-registry] retry skipped ch=${channelId} — already live`,
              );
              return;
            }
            this.scheduleOpen(key, channelId, mode, sink, retryCount + 1);
          }, retryDelay);
          this.pendingRetryTimers.add(timer);
        } else if (this.sinkRegistry.has(key) && !this.streams.has(key)) {
          debugLog.error(
            `[stream-registry] giving up ch=${channelId} after ${retryCount + 1} attempts`,
          );
          cameraStore.getState().updateStatus(channelId, "failed");
          this.deps.recovery.noteGiveUp();
        }
      };
      // Reconnect on stall (no frames for 8s after stream was working)
      conn.onStalled = () => {
        if (this.streams.get(key) !== conn) return;
        this.streams.delete(key);
        this.streamSessions.delete(key);
        conn.close();
        if (this.sinkRegistry.has(key) && this.deps.sessions.primary) {
          this.scheduleOpen(key, channelId, mode, sink);
        }
      };
      conn.open(session.host, session.sessionId, sink);
      this.streams.set(key, conn);
      this.streamSessions.set(key, session);
      // Transfer the claim — streamSessions now accounts for the slot.
      this.deps.sessions.releaseLiveSlot(session);
    };

    doOpen();
  }
}
