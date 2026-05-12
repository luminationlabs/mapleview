import { nvrClient } from "./client";
import { PlaybackConnection } from "./playback-connection";
import type { CameraInfo, FrameSink, NvrSession, StreamMode } from "./types";
import { playbackStore, segmentCoveringTime } from "../store/playback-store";
import { unixToUtcTimeStr, utcTimeStrToUnix } from "../utils/time";

/**
 * Orchestrates multiple PlaybackConnections using NVRClient's session pool.
 * Live and playback share the same pool — slots are claimed/released
 * through acquirePlaybackSlot / releasePlaybackSlot. Singleton — use the
 * `playbackManager` export.
 */
class PlaybackManager {
  private static instance: PlaybackManager | null = null;

  /** Stagger delay between opening connections (ms). */
  private static readonly STAGGER_MS = 200;

  private connections = new Map<string, PlaybackConnection>();
  private connectionSessions = new Map<string, NvrSession>();
  private sinks = new Map<string, FrameSink>();
  /** Per-channel metadata captured at openAll, used for seek-as-reopen. */
  private channelMeta = new Map<
    string,
    { mode: StreamMode; startTime: number; endTime: number }
  >();
  /** Channels with an in-flight openOne. Dedups rapid scrubs that would
   *  otherwise spawn concurrent openOnes for every still-loading channel. */
  private pendingOpens = new Set<string>();
  /** Monotonic counter bumped on handleBackground. openOneInner captures
   *  this and self-aborts at each await if the epoch advanced — prevents a
   *  stale open from displacing a fresh connection on foreground. */
  private openEpoch = 0;
  /** Current intended playback target. Updated on openAll and seekAll;
   *  pending staggered openOnes read this so they don't open at a stale
   *  start time after the user has already scrubbed elsewhere. */
  private currentStart: number | null = null;
  private currentSeekTimeStr: string | null = null;

  /** Last-known per-camera coverage (playhead inside one of its segments).
   *  Driven by reconcileCoverage via a playbackStore subscription; checked
   *  against fresh evaluation each tick so we only act on transitions. */
  private coverageByChannel = new Map<string, boolean>();
  private timeSubscriptionUnsub: (() => void) | null = null;

  /** Pending pre-frame retry timers from openOne's onConnectionFailed.
   *  Tracked so teardown can cancel stale retries that would otherwise
   *  race the foreground wave. */
  private openRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private static readonly OPEN_RETRY_MAX_ATTEMPTS = 3;

  private constructor() {}

  static getInstance(): PlaybackManager {
    if (!PlaybackManager.instance) {
      PlaybackManager.instance = new PlaybackManager();
    }
    return PlaybackManager.instance;
  }

  static resetForTesting(): void {
    if (PlaybackManager.instance) {
      PlaybackManager.instance.closeAll();
      const unsub = PlaybackManager.instance.timeSubscriptionUnsub;
      if (unsub) unsub();
      PlaybackManager.instance.timeSubscriptionUnsub = null;
    }
    PlaybackManager.instance = null;
  }

  get latestSession(): NvrSession | null {
    return nvrClient.latestSession;
  }

  /**
   * Open playback connections for all cameras.
   *
   * @param mode - Stream mode (default: 'main'). Main streams are recorded
   *   at native fps so the server's ~25fps delivery yields ~1× speed; sub
   *   streams are lower-fps so delivery at 25fps plays back at multiple×.
   */
  openAll(
    cameras: CameraInfo[],
    startTime: number,
    endTime: number,
    mode: StreamMode = "main",
  ): void {
    // Anchor the shared pacing baseline so all connections pace to the
    // same expected time, not to whichever frame lands first.
    PlaybackConnection.setPacingBaseline(startTime);
    this.currentStart = startTime;
    this.currentSeekTimeStr = null;
    cameras.forEach((camera, index) => {
      this.channelMeta.set(camera.channelId, { mode, startTime, endTime });
      const covered = this.isChannelCoveredAtTime(camera.channelId, startTime);
      this.coverageByChannel.set(camera.channelId, covered);
      if (!covered) {
        // In a gap — don't open. The NVR would clamp start_time to the
        // camera's nearest recording, desyncing this tile from the rest.
        // reconcileCoverage will open it when the playhead enters coverage.
        playbackStore.getState().setChannelLoading(camera.channelId, false);
        return;
      }
      const delay = index * PlaybackManager.STAGGER_MS;
      if (delay === 0) {
        this.openOne(camera.channelId, mode, startTime, endTime);
      } else {
        setTimeout(() => {
          this.openOne(camera.channelId, mode, startTime, endTime);
        }, delay);
      }
    });
    this.ensureTimeSubscription();
  }

  /**
   * Close all playback connections and release their session slots.
   *
   * Does NOT clear `sinks` / `sinkStacks` — those are view-owned, driven
   * by attach/detach. If the view is still mounted (day-switch, tab-switch
   * with stack preservation), clearing them would lose the registration
   * and the next openAll's frames would be delivered to a no-op sink.
   */
  closeAll(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    for (const session of this.connectionSessions.values()) {
      nvrClient.releasePlaybackSlot(session);
    }
    for (const t of this.openRetryTimers) clearTimeout(t);
    this.openRetryTimers.clear();
    // Clear failed flags so tabs/days/cold-relaunch don't re-open with
    // stale "Can't load" overlays.
    const pbStore = playbackStore.getState();
    for (const channelId of Object.keys(pbStore.failedChannels)) {
      pbStore.setChannelFailed(channelId, false);
    }
    this.connections.clear();
    this.connectionSessions.clear();
    this.channelMeta.clear();
    this.coverageByChannel.clear();
    this.currentStart = null;
    this.currentSeekTimeStr = null;
    this.pendingOpens.clear();
    // Leftover resync flags would make the next openAll's first frame
    // trigger a spurious restart (e.g. date change: closeAll → openAll
    // → first frame → upgradeMode sees leftover flag → restarts).
    this.resyncPendingAfterAttach.clear();
    PlaybackConnection.resetSharedPacing();
  }

  /**
   * Tear down all WS connections on background. iOS kills WebSockets after
   * ~30s anyway; without this the stale conns linger until their stall
   * watchdog fires and create confused reopen attempts on foreground.
   * Keeps channelMeta and sinks so handleForeground can restore.
   */
  handleBackground(): void {
    // Invalidate in-flight openOneInner calls so they self-abort at their
    // next await rather than displacing a fresh foreground connection.
    this.openEpoch++;
    for (const conn of this.connections.values()) {
      conn.close();
    }
    for (const session of this.connectionSessions.values()) {
      nvrClient.releasePlaybackSlot(session);
    }
    // Cancel pending retries so they don't race the foreground wave.
    for (const t of this.openRetryTimers) clearTimeout(t);
    this.openRetryTimers.clear();
    // Drop the "Can't load" overlay as soon as teardown starts — otherwise
    // the retry button stays visible through hardRetry's 1–3 s login.
    const pbStore = playbackStore.getState();
    for (const channelId of Object.keys(pbStore.failedChannels)) {
      pbStore.setChannelFailed(channelId, false);
    }
    this.connections.clear();
    this.connectionSessions.clear();
    this.pendingOpens.clear();
    // Drop coverage so handleForeground reinitializes from the saved
    // playhead — stale `true` entries would suppress the reconcile reopen.
    this.coverageByChannel.clear();
    // Mounted views would otherwise interpret the first new foreground
    // frame as a resync trigger, restarting a just-opened task.
    this.resyncPendingAfterAttach.clear();
    // Sessions are owned by nvrClient and preserved across background.
  }

  /**
   * Reopen all channels that had active sinks when backgrounded, using
   * the most-recent-known playback position so the user picks up where
   * they left off (not rewound to task start).
   */
  handleForeground(): void {
    const meta = [...this.channelMeta.entries()];
    if (meta.length === 0) return;

    // Spinner on every tile immediately — without this there's a visible
    // gap between foreground and the first staggered openOne, during
    // which tiles show stale last-rendered frames or black.
    const store = playbackStore.getState();
    for (const [channelId] of meta) {
      store.setChannelLoading(channelId, true);
    }

    const currentUi = playbackStore.getState().currentTime;

    // Reset the pacing baseline — sharedSeekWall was set possibly minutes
    // ago, and without this the first frames arrive with deeply negative
    // lead, triggering rapid pause/resume cycles (~1s).
    const baselineFrom =
      currentUi != null && currentUi > 0
        ? currentUi
        : this.currentStart != null && this.currentStart > 0
          ? this.currentStart
          : null;
    if (baselineFrom != null) {
      PlaybackConnection.setPacingBaseline(Math.floor(baselineFrom));
    }
    const rawSeek =
      currentUi != null && currentUi > 0
        ? currentUi
        : this.currentStart != null && this.currentStart > 0
          ? this.currentStart
          : null;

    meta.forEach(([channelId, m], index) => {
      const startTime =
        rawSeek != null ? Math.floor(rawSeek) : m.startTime;
      const initialSeekTime =
        rawSeek != null ? unixToUtcTimeStr(Math.floor(rawSeek)) : null;
      const covered = this.isChannelCoveredAtTime(channelId, startTime);
      this.coverageByChannel.set(channelId, covered);
      if (!covered) {
        playbackStore.getState().setChannelLoading(channelId, false);
        return;
      }
      const delay = index * PlaybackManager.STAGGER_MS;
      if (delay === 0) {
        this.openOne(channelId, m.mode, startTime, m.endTime, initialSeekTime);
      } else {
        setTimeout(() => {
          this.openOne(
            channelId,
            m.mode,
            startTime,
            m.endTime,
            initialSeekTime,
          );
        }, delay);
      }
    });
    this.ensureTimeSubscription();
  }

  /**
   * Fast-path seek: try an in-place `all_frame` on each existing connection
   * first — avoids close/reopen/pre-buffer latency when the NVR honors
   * mid-task seeks. Falls back to restart() per-connection on failure, so
   * behavior is never worse than seekAll().
   *
   * Caller should ensure the target is likely in-coverage (small delta) —
   * large jumps hit close/reopen regardless.
   */
  trySeekInPlace(frameTime: string): void {
    const trimmed = frameTime.length > 19 ? frameTime.slice(0, 19) : frameTime;
    const newStart = Math.floor(utcTimeStrToUnix(trimmed));
    PlaybackConnection.setPacingBaseline(newStart);
    this.currentStart = newStart;
    this.currentSeekTimeStr = frameTime;
    const channels = Array.from(this.channelMeta.keys());
    channels.forEach((channelId) => {
      const meta = this.channelMeta.get(channelId);
      if (!meta) return;
      const existing = this.connections.get(channelId);
      const covered = this.isChannelCoveredAtTime(channelId, newStart);
      this.coverageByChannel.set(channelId, covered);
      if (!covered) {
        if (existing) {
          existing.close();
          this.connections.delete(channelId);
          this.releaseChannelSession(channelId);
          this.resyncPendingAfterAttach.delete(channelId);
          playbackStore.getState().setChannelLoading(channelId, false);
        }
        return;
      }
      if (!existing) {
        this.openOne(channelId, meta.mode, newStart, meta.endTime, frameTime);
        return;
      }
      existing.seekInPlace(frameTime, newStart).then((result) => {
        if (result === "ok") return;
        // A newer seekInPlace owns the in-flight state — don't race it.
        if (result === "superseded") return;
        console.log(
          `[playback-manager] in-place seek ${result} for ${channelId.slice(1, 9)} — falling back to restart`,
        );
        existing.restart(newStart, meta.endTime, frameTime).then((restarted) => {
          if (restarted) return;
          this.connections.delete(channelId);
          this.releaseChannelSession(channelId);
          this.openOne(channelId, meta.mode, newStart, meta.endTime, frameTime);
        });
      });
    });
  }

  /**
   * Seek by closing + reopening each connection at the new time.
   * The web client does the same; mid-stream `playback/all_frame` on the
   * existing task does not reliably change server-side position.
   *
   * @param frameTime - Target time as "YYYY-MM-DD HH:MM:SS:mmm"
   */
  seekAll(frameTime: string): void {
    const trimmed = frameTime.length > 19 ? frameTime.slice(0, 19) : frameTime;
    const newStart = Math.floor(utcTimeStrToUnix(trimmed));
    PlaybackConnection.setPacingBaseline(newStart);
    this.currentStart = newStart;
    this.currentSeekTimeStr = frameTime;
    // Iterate every known channel — including dead-WS ones dropped from
    // `connections` — so a user scrub revives dead tiles.
    const channels = Array.from(this.channelMeta.keys());
    console.log(
      `[playback-manager] seekAll to ${frameTime} (unix=${newStart}): reopening ${channels.length} connections`,
    );
    // Stagger both restarts and fresh opens. Concentrated bursts produce
    // HTTP 400s on some channels and contending first-frame bursts that
    // desync pacing pauses across cameras (oscillation for ~10-30s).
    channels.forEach((channelId, index) => {
      const meta = this.channelMeta.get(channelId);
      if (!meta) return;
      const existing = this.connections.get(channelId);
      const covered = this.isChannelCoveredAtTime(channelId, newStart);
      this.coverageByChannel.set(channelId, covered);
      const delay = index * PlaybackManager.STAGGER_MS;
      const fire = () => {
        if (!covered) {
          // Seeked into a gap. Tear down; reconcileCoverage reopens when
          // the playhead advances into the next segment.
          if (existing) {
            existing.close();
            this.connections.delete(channelId);
            this.releaseChannelSession(channelId);
            this.resyncPendingAfterAttach.delete(channelId);
            playbackStore.getState().setChannelLoading(channelId, false);
          }
          return;
        }
        if (existing) {
          // Preferred: restart on the existing WS (no session churn, no
          // WS handshake, fresh keyframe promptly).
          existing.restart(newStart, meta.endTime, frameTime).then((ok) => {
            if (ok) return;
            // WS died — full reopen.
            this.connections.delete(channelId);
            this.releaseChannelSession(channelId);
            this.openOne(channelId, meta.mode, newStart, meta.endTime, frameTime);
          });
          return;
        }
        this.openOne(channelId, meta.mode, newStart, meta.endTime, frameTime);
      };
      if (delay === 0) fire();
      else setTimeout(fire, delay);
    });
  }

  pauseAll(): void {
    for (const conn of this.connections.values()) {
      conn.setUserPaused(true);
    }
  }

  resumeAll(): void {
    for (const conn of this.connections.values()) {
      conn.setUserPaused(false);
    }
  }

  /** Pause one channel — for single-cam where the visible camera should
   *  pause without affecting the 11 background-paused siblings. */
  pauseChannel(channelId: string): void {
    this.connections.get(channelId)?.setUserPaused(true);
  }

  resumeChannel(channelId: string): void {
    this.connections.get(channelId)?.setUserPaused(false);
  }

  /**
   * Close every connection except the named one, keeping channelMeta for
   * later reopen. Called when entering single-cam: the grid stays mounted
   * but its 11 off-screen tiles don't need live connections — running
   * 12 simultaneous restarts on every seek hits pacing edge cases and
   * triggers stuck/reopen cascades.
   */
  closeAllExcept(channelId: string): void {
    // Focus this channel so its HQ pref takes effect (grid main conns
    // are unfocused → stream 1).
    this.setFocusedChannel(channelId);
    for (const [id, conn] of Array.from(this.connections)) {
      if (id === channelId) continue;
      conn.close();
      this.connections.delete(id);
      this.releaseChannelSession(id);
      this.resyncPendingAfterAttach.delete(id);
      this.pendingOpens.delete(id);
      playbackStore.getState().setChannelLoading(id, false);
    }
  }

  /**
   * Reopen siblings of `channelId` at the current UI playhead. Mirror of
   * `closeAllExcept`. Idempotent — no-op (including no pacing-baseline
   * write) when nothing needs opening, otherwise redundant calls would
   * shift sharedSeekUnix and desync already-streaming connections.
   */
  reopenAllExcept(channelId: string): void {
    // Drop focus so the previously-focused main conn returns to stream 1
    // and sibling opens resolve to stream 1 too.
    this.setFocusedChannel(null);
    const toOpen: {
      id: string;
      meta: { mode: StreamMode; startTime: number; endTime: number };
    }[] = [];
    for (const [id, meta] of this.channelMeta) {
      if (id === channelId) continue;
      if (this.connections.has(id)) continue;
      if (this.pendingOpens.has(id)) continue;
      toOpen.push({ id, meta });
    }
    if (toOpen.length === 0) return;

    const ui = playbackStore.getState().currentTime;
    const rawSeek =
      ui != null && ui > 0
        ? ui
        : this.currentStart != null && this.currentStart > 0
          ? this.currentStart
          : null;
    if (rawSeek == null) return;
    const seekFrom = Math.floor(rawSeek);
    const frameTime = unixToUtcTimeStr(seekFrom);
    this.currentStart = seekFrom;
    this.currentSeekTimeStr = frameTime;
    PlaybackConnection.setPacingBaseline(seekFrom);
    for (const { id, meta } of toOpen) {
      const covered = this.isChannelCoveredAtTime(id, seekFrom);
      this.coverageByChannel.set(id, covered);
      if (!covered) {
        playbackStore.getState().setChannelLoading(id, false);
        continue;
      }
      this.openOne(id, meta.mode, seekFrom, meta.endTime, frameTime);
    }
  }

  /**
   * Set playback speed on all current and future connections.
   *
   * Crossing the keyframe-only threshold full-restarts each affected
   * connection rather than relying on a mid-task /key_frame toggle —
   * the NVR doesn't reliably re-emit an IDR from the bare toggle.
   */
  private currentSpeed = 1;
  setSpeed(speed: number): void {
    this.currentSpeed = speed;
    // Rebase the pacing baseline at current UI time so expectedUnix
    // doesn't jump on speed change (would produce runaway lag or
    // sudden pause cascade).
    const currentUi = playbackStore.getState().currentTime;
    if (currentUi != null && currentUi > 0) {
      PlaybackConnection.setPacingBaseline(currentUi);
    }
    for (const [channelId, conn] of this.connections) {
      const needsRestart = conn.setSpeed(speed);
      if (!needsRestart) continue;
      const meta = this.channelMeta.get(channelId);
      if (!meta) continue;
      // Priority for "where are we actually playing":
      // displayUnix > currentUi > currentStart > meta.startTime.
      // Skip restart if all are unavailable rather than passing 0
      // (the NVR would clamp to its earliest recording).
      const displayUnix = conn.getEstimatedDisplayUnix();
      const rawSeek =
        displayUnix != null && displayUnix > 0
          ? displayUnix
          : currentUi != null && currentUi > 0
            ? currentUi
            : this.currentStart != null && this.currentStart > 0
              ? this.currentStart
              : meta.startTime > 0
                ? meta.startTime
                : null;
      if (rawSeek == null) continue;
      // Floor to integer unix seconds — fractional start_time confuses
      // the NVR and it falls back to its earliest recording.
      const seekFrom = Math.floor(rawSeek);
      const frameTime = unixToUtcTimeStr(seekFrom);
      // If the rewound target straddles a segment boundary into a gap,
      // close instead — restart would land on NVR-clamped content.
      if (!this.isChannelCoveredAtTime(channelId, seekFrom)) {
        this.coverageByChannel.set(channelId, false);
        conn.close();
        this.connections.delete(channelId);
        this.releaseChannelSession(channelId);
        this.resyncPendingAfterAttach.delete(channelId);
        playbackStore.getState().setChannelLoading(channelId, false);
        continue;
      }
      conn.restart(seekFrom, meta.endTime, frameTime).then((ok) => {
        if (ok) return;
        this.connections.delete(channelId);
        this.releaseChannelSession(channelId);
        this.openOne(channelId, meta.mode, seekFrom, meta.endTime, frameTime);
      });
    }
  }

  /** The channel currently displayed by single-cam, or null on grid.
   *  Only the focused channel respects HQ — 12 × stream 0 (4K H.265)
   *  would saturate bandwidth and thermal budget. */
  private focusedChannel: string | null = null;

  /** Single-cam mount/unmount hook. Outgoing drops from stream 0 to
   *  stream 1; incoming upgrades on entry (when HQ is on at 1×). */
  setFocusedChannel(channelId: string | null): void {
    const prev = this.focusedChannel;
    if (prev === channelId) return;
    this.focusedChannel = channelId;
    if (prev != null) this.updateConnectionHq(prev);
    if (channelId != null) this.updateConnectionHq(channelId);
  }

  /** Effective HQ = user pref AND channel is focused. Sub-mode ignores
   *  this (always stream 2). */
  private effectiveHqFor(channelId: string): boolean {
    return this.getHqMode() && channelId === this.focusedChannel;
  }

  /** Propagate ui-store HQ change to every live main-mode connection. */
  hqModeChanged(): void {
    for (const channelId of Array.from(this.connections.keys())) {
      this.updateConnectionHq(channelId);
    }
  }

  /** Reconcile one main-mode connection's hqMode, restarting only if
   *  resolved stream_index would change. Skips sub-mode (always stream 2)
   *  and main-mode at speed > 1× (always stream 1 — both HQ values
   *  collapse to the same resolution there). */
  private updateConnectionHq(channelId: string): void {
    const conn = this.connections.get(channelId);
    const meta = this.channelMeta.get(channelId);
    if (!conn || !meta || meta.mode !== "main") return;
    const wantHq = this.effectiveHqFor(channelId);
    if (conn.getHqMode() === wantHq) return;
    conn.setHqMode(wantHq);
    if (this.currentSpeed > 1) return;
    const displayUnix = conn.getEstimatedDisplayUnix();
    const currentUi = playbackStore.getState().currentTime;
    const rawSeek =
      displayUnix != null && displayUnix > 0
        ? displayUnix
        : currentUi != null && currentUi > 0
          ? currentUi
          : this.currentStart != null && this.currentStart > 0
            ? this.currentStart
            : meta.startTime > 0
              ? meta.startTime
              : null;
    if (rawSeek == null) return;
    const seekFrom = Math.floor(rawSeek);
    const frameTime = unixToUtcTimeStr(seekFrom);
    if (!this.isChannelCoveredAtTime(channelId, seekFrom)) {
      this.coverageByChannel.set(channelId, false);
      conn.close();
      this.connections.delete(channelId);
      this.releaseChannelSession(channelId);
      this.resyncPendingAfterAttach.delete(channelId);
      playbackStore.getState().setChannelLoading(channelId, false);
      return;
    }
    conn.restart(seekFrom, meta.endTime, frameTime).then((ok) => {
      if (ok) return;
      this.connections.delete(channelId);
      this.releaseChannelSession(channelId);
      this.openOne(channelId, meta.mode, seekFrom, meta.endTime, frameTime);
    });
  }

  getSink(channelId: string): FrameSink | null {
    return this.sinks.get(channelId) ?? null;
  }

  /** Pre-register a sink for a channel before openAll. Used by single-cam
   *  swipe-to-switch so openOne picks up the real sink immediately instead
   *  of the noop fallback during the React re-render gap. Doesn't touch
   *  sinkStacks or resync flags — those are the hook's attach call's job. */
  primeSinkFor(channelId: string, sink: FrameSink): void {
    this.sinks.set(channelId, sink);
  }

  /**
   * Register a frame sink. If a connection already exists, its sink is
   * swapped — but the new view has no format description yet, so any
   * P-frames before the next IDR are dropped and the tile sits blank.
   * upgradeMode (called after first-frame confirms view-readiness)
   * restarts the task so the server emits a fresh IDR.
   *
   * If `mode` differs from the existing connection's mode (e.g., grid
   * "sub" → single "main"), the old connection is torn down — a
   * PlaybackConnection's stream mode is fixed at construction.
   */
  attach(channelId: string, sink: FrameSink, mode?: StreamMode): void {
    this.sinks.set(channelId, sink);
    // Push onto the per-channel sink stack so detach can restore the
    // previous one (grid ↔ single-camera transitions).
    let stack = this.sinkStacks.get(channelId);
    if (!stack) {
      stack = [];
      this.sinkStacks.set(channelId, stack);
    }
    if (!stack.length || stack[stack.length - 1].sink !== sink) {
      stack.push({ sink, mode });
    }
    const conn = this.connections.get(channelId);
    if (!conn) {
      // No connection yet. If a tab-refocus openAll('sub') is racing a
      // single-camera attach('main'), rewrite meta.mode so the in-flight
      // openOneInner constructs in the requested mode.
      if (mode) {
        const meta = this.channelMeta.get(channelId);
        if (meta && meta.mode !== mode) {
          this.channelMeta.set(channelId, { ...meta, mode });
        }
      }
      return;
    }
    conn.setSink(sink);

    if (mode) {
      const meta = this.channelMeta.get(channelId);
      if (meta && meta.mode !== mode) {
        this.channelMeta.set(channelId, { ...meta, mode });
      }
    }

    // Flag for resync — without it, the new view anchors CMTimebase to
    // the leading edge of the pacing buffer (5-20s ahead of where the
    // user was watching). upgradeMode picks this up.
    this.resyncPendingAfterAttach.add(channelId);

    // Don't restart here — restarting before viewRef registration loses
    // the fresh IDR. upgradeMode fires after hasFirstFrame.
  }

  /** Per-channel sink stack: grid tile pushes 'sub' first, single-cam
   *  pushes 'main' on top, detach pops to restore the grid. If modes
   *  don't match on restore, upgradeMode swaps to avoid decoding main
   *  frames with sub format descriptions (green artifacts). */
  private sinkStacks = new Map<string, { sink: FrameSink; mode?: StreamMode }[]>();

  /** Channels needing CMTimebase re-anchor on the next frame (sink-swap
   *  onto an already-streaming conn — pacing buffer is up to
   *  PACING_LEAD_MS+ ahead of the prior view's display). Cleared in
   *  upgradeMode after it restarts at a rewound seek. */
  private resyncPendingAfterAttach = new Set<string>();

  /** Per-sink callbacks fired right before a timebase-disturbing restart
   *  (upgradeMode / detach-restore). Keyed by sink, not channelId, because
   *  grid + single both register for the same channel. use-playback's
   *  handler flushes viewRef so CMTimebase resets on the next IDR
   *  instead of DisplayImmediately-bursting. */
  private resyncHandlers = new Map<FrameSink, () => void>();

  setResyncHandler(sink: FrameSink, handler: (() => void) | null): void {
    if (handler) this.resyncHandlers.set(sink, handler);
    else this.resyncHandlers.delete(sink);
  }

  /** Remove the sink for a channel. Pops from the per-channel stack; if
   *  a previous sink exists underneath, it becomes active and the
   *  connection is swapped back to that sink's stream mode if needed. */
  detach(channelId: string, sink?: FrameSink): void {
    const stack = this.sinkStacks.get(channelId);
    if (stack) {
      if (sink) {
        let idx = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].sink === sink) { idx = i; break; }
        }
        if (idx >= 0) stack.splice(idx, 1);
      } else if (stack.length > 0) {
        // No sink specified — undo the most recent attach.
        stack.pop();
      }
    }
    const restored = stack && stack.length > 0 ? stack[stack.length - 1] : null;
    if (restored) {
      this.sinks.set(channelId, restored.sink);
      const conn = this.connections.get(channelId);
      if (conn) {
        conn.setSink(restored.sink);
        if (restored.mode && conn.mode !== restored.mode) {
          // Mode swap back (single 'main' → grid 'sub').
          this.resyncPendingAfterAttach.add(channelId);
          this.upgradeMode(channelId, restored.mode);
        } else {
          // Same-mode restore: grid's CMTimebase ran free while single
          // was on top — now ~15s ahead of the stream, every incoming
          // sample triggers DisplayImmediately. Flush + restart at
          // lastPts (no rewind — preserves continuity from single-view).
          this.resyncHandlers.get(restored.sink)?.();
          const meta = this.channelMeta.get(channelId);
          const lastFrameUnix = conn.getLastFrameUnix();
          if (meta && lastFrameUnix != null && lastFrameUnix > 0) {
            const seekFrom = Math.floor(lastFrameUnix);
            const frameTime = unixToUtcTimeStr(seekFrom);
            conn.restart(seekFrom, meta.endTime, frameTime).then((ok) => {
              if (ok) return;
              this.connections.delete(channelId);
              this.releaseChannelSession(channelId);
              this.openOne(channelId, conn.mode, seekFrom, meta.endTime, frameTime);
            });
          }
        }
      }
    } else {
      this.sinks.delete(channelId);
      const conn = this.connections.get(channelId);
      if (conn) conn.setSink(() => {});
    }
  }

  /**
   * Re-anchor playback to the freshly-mounted view. Fired by use-playback
   * after hasFirstFrame confirms the view is ready for an IDR. No-op when
   * mode matches and no resync is pending.
   */
  upgradeMode(channelId: string, mode: StreamMode): void {
    const conn = this.connections.get(channelId);
    const meta = this.channelMeta.get(channelId);
    if (!conn || !meta) return;

    const modeChange = conn.mode !== mode;
    const resync = this.resyncPendingAfterAttach.has(channelId);
    if (!modeChange && !resync) return;
    this.resyncPendingAfterAttach.delete(channelId);

    // Prefer displayUnix (lastPts runs ahead of what's on screen, UI
    // clock drifts across pause/background). Update currentStart, realign
    // pacing baseline, and flush the native view so CMTimebase rebases
    // on the new IDR.
    const displayUnix = conn.getEstimatedDisplayUnix();
    const currentUi = playbackStore.getState().currentTime;
    const rawSeek =
      displayUnix != null && displayUnix > 0
        ? displayUnix
        : currentUi != null && currentUi > 0
          ? currentUi
          : this.currentStart != null && this.currentStart > 0
            ? this.currentStart
            : null;
    if (rawSeek == null) return;
    const seekFrom = Math.floor(rawSeek);
    const frameTime = unixToUtcTimeStr(seekFrom);
    this.currentStart = seekFrom;
    this.currentSeekTimeStr = frameTime;
    PlaybackConnection.setPacingBaseline(seekFrom);
    const activeSink = this.sinks.get(channelId);
    if (activeSink) this.resyncHandlers.get(activeSink)?.();

    if (modeChange) {
      // stream_index is fixed at PlaybackConnection construction.
      this.connections.delete(channelId);
      this.releaseChannelSession(channelId);
      conn.close();
      this.channelMeta.set(channelId, { ...meta, mode });
      this.openOne(channelId, mode, seekFrom, meta.endTime, frameTime);
      return;
    }

    // Same mode: cheaper restart on the existing WS (no session handshake).
    conn.restart(seekFrom, meta.endTime, frameTime).then((ok) => {
      if (ok) return;
      // WS died — full reopen.
      this.connections.delete(channelId);
      this.releaseChannelSession(channelId);
      this.openOne(channelId, mode, seekFrom, meta.endTime, frameTime);
    });
  }

  /** Does this camera have a recording segment covering `unixTime`?
   *  playback/open with start_time outside a camera's range is silently
   *  clamped by the NVR to its nearest recording — so cameras with less
   *  history would stream their first-ever recording while the playhead
   *  sits in a gap. Skip them instead. */
  private isChannelCoveredAtTime(channelId: string, unixTime: number): boolean {
    const segs = playbackStore.getState().cameraSegments[channelId];
    return segmentCoveringTime(segs, unixTime) != null;
  }

  /** Subscribe once to playbackStore — on each currentTime change,
   *  reconcile per-camera coverage so playhead crossings of segment
   *  boundaries open/close connections automatically. */
  private ensureTimeSubscription(): void {
    if (this.timeSubscriptionUnsub) return;
    let lastTime = playbackStore.getState().currentTime;
    let lastSegments = playbackStore.getState().cameraSegments;
    this.timeSubscriptionUnsub = playbackStore.subscribe((state) => {
      if (
        state.currentTime === lastTime &&
        state.cameraSegments === lastSegments
      ) {
        return;
      }
      lastTime = state.currentTime;
      lastSegments = state.cameraSegments;
      this.reconcileCoverage(state.currentTime);
    });
  }

  /** Fire open/close on per-channel coverage transitions. Called from
   *  the playbackStore time subscription; cheap because coverageByChannel
   *  short-circuits non-transitions. */
  private reconcileCoverage(currentTime: number): void {
    if (this.channelMeta.size === 0) return;
    // Integer unix seconds — fractional start_time → NVR falls back to
    // earliest recording.
    const seekFrom = Math.floor(currentTime);
    for (const [channelId, meta] of this.channelMeta) {
      const covered = this.isChannelCoveredAtTime(channelId, seekFrom);
      const wasCovered = this.coverageByChannel.get(channelId) ?? false;
      if (covered === wasCovered) continue;
      this.coverageByChannel.set(channelId, covered);
      if (covered) {
        // Playhead entered coverage — open at currentTime. openOne dedups
        // via pendingOpens so rapid transitions don't spawn concurrent opens.
        if (!this.connections.has(channelId)) {
          const frameTime = unixToUtcTimeStr(seekFrom);
          // Update currentStart so openOneInner's `effectiveStart`
          // resolves to the fresh playhead, not the stale openAll time
          // (which is in a gap for this camera, so the post-await
          // coverage guard would loop forever).
          this.currentStart = seekFrom;
          this.currentSeekTimeStr = frameTime;
          // Re-align pacing baseline so a late-joiner's first frame
          // doesn't disrupt already-smooth cameras.
          PlaybackConnection.setPacingBaseline(seekFrom);
          this.openOne(channelId, meta.mode, seekFrom, meta.endTime, frameTime);
        }
      } else {
        // Left coverage — tear down so the NVR doesn't keep streaming
        // past the segment boundary.
        const conn = this.connections.get(channelId);
        if (conn) {
          conn.close();
          this.connections.delete(channelId);
          this.releaseChannelSession(channelId);
          this.resyncPendingAfterAttach.delete(channelId);
          playbackStore.getState().setChannelLoading(channelId, false);
        }
      }
    }
  }

  /** Reserve a session slot via nvrClient. All session lifecycle lives
   *  there; this wrapper records the channel→session binding. */
  private async reserveSession(channelId: string): Promise<NvrSession | null> {
    const session = await nvrClient.acquirePlaybackSlot();
    if (!session) return null;
    this.connectionSessions.set(channelId, session);
    return session;
  }

  /** Release a channel's session binding. All connections.delete() paths
   *  must go through here to keep nvrClient's slot accounting in sync.
   *  No-op when no binding exists. */
  private releaseChannelSession(channelId: string): void {
    const session = this.connectionSessions.get(channelId);
    if (!session) return;
    this.connectionSessions.delete(channelId);
    nvrClient.releasePlaybackSlot(session);
  }

  private async openOne(
    channelId: string,
    mode: StreamMode,
    startTime: number,
    endTime: number,
    initialSeekTime: string | null = null,
    retryCount = 0,
  ): Promise<void> {
    if (this.pendingOpens.has(channelId)) {
      console.log(`[playback-manager] openOne skipped — already in flight for ${channelId.slice(1, 9)}`);
      return;
    }
    this.pendingOpens.add(channelId);
    try {
      await this.openOneInner(channelId, mode, startTime, endTime, initialSeekTime, retryCount);
    } finally {
      this.pendingOpens.delete(channelId);
    }
  }

  private async openOneInner(
    channelId: string,
    mode: StreamMode,
    startTime: number,
    endTime: number,
    initialSeekTime: string | null = null,
    retryCount = 0,
  ): Promise<void> {
    console.log(`[playback-manager] openOne starting for channel ${channelId.slice(1, 9)}`);

    // Capture the epoch so we can abort if a background/foreground
    // cycle happened mid-reservation.
    const epoch = this.openEpoch;

    // Wait for nvrClient to finish validating the primary session.
    // Otherwise a synchronous openOne from use-app-lifecycle racing
    // nvrClient.handleForeground gets a slot on a stale primary whose
    // WS upgrades return HTTP 400.
    await nvrClient.awaitForegroundReady();
    if (this.openEpoch !== epoch) return;

    const existing = this.connections.get(channelId);
    if (existing) {
      existing.close();
      this.connections.delete(channelId);
      this.releaseChannelSession(channelId);
    }

    const session = await this.reserveSession(channelId);
    if (this.openEpoch !== epoch) {
      // Background fired during await — release the claim we just took
      // (reserveSession already incremented playbackClaims).
      this.releaseChannelSession(channelId);
      return;
    }
    if (!session) {
      console.log(`[playback-manager] openOne FAILED for channel ${channelId.slice(1, 9)} — no session available`);
      return;
    }

    const sink = this.sinks.get(channelId) ?? (() => {});

    // Re-read mode from channelMeta — if attach() updated it during the
    // await (e.g. single-cam deep-link during openAll), honor that.
    const effectiveMode = this.channelMeta.get(channelId)?.mode ?? mode;

    const conn = new PlaybackConnection(channelId, effectiveMode);

    // Clear prior failed state so UI swaps from error overlay to spinner.
    playbackStore.getState().setChannelFailed(channelId, false);

    conn.onConnectionFailed = () => {
      // Displacement guard: a newer open may have replaced this conn.
      if (this.connections.get(channelId) !== conn) return;
      this.connections.delete(channelId);
      this.releaseChannelSession(channelId);
      this.resyncPendingAfterAttach.delete(channelId);
      // Retry a few times with backoff. Skip if untracked or epoch moved.
      const canRetry =
        retryCount < PlaybackManager.OPEN_RETRY_MAX_ATTEMPTS - 1 &&
        this.channelMeta.has(channelId) &&
        this.openEpoch === epoch;
      if (canRetry) {
        const jitter = Math.random() * 800;
        const retryDelay = Math.round(1000 + retryCount * 1000 + jitter);
        console.log(
          `[playback-manager] retry ch=${channelId.slice(1, 9)} attempt=${retryCount + 1}/${PlaybackManager.OPEN_RETRY_MAX_ATTEMPTS} in ${retryDelay}ms`,
        );
        const timer = setTimeout(() => {
          this.openRetryTimers.delete(timer);
          if (this.openEpoch !== epoch) return;
          // Read meta at fire time — channel may have been retargeted
          // (mode upgrade, day switch) between scheduling and firing.
          const meta = this.channelMeta.get(channelId);
          if (!meta) return;
          // Skip if a later open (e.g. seek-triggered) already succeeded.
          const existingNow = this.connections.get(channelId);
          if (existingNow && existingNow.isAlive) return;
          this.openOne(channelId, meta.mode, meta.startTime, meta.endTime, initialSeekTime, retryCount + 1);
        }, retryDelay);
        this.openRetryTimers.add(timer);
      } else {
        // Retries exhausted — surface the failure so UI can show a
        // retry affordance instead of an indefinite spinner.
        playbackStore.getState().setChannelLoading(channelId, false);
        if (this.channelMeta.has(channelId)) {
          playbackStore.getState().setChannelFailed(channelId, true);
        }
      }
    };

    conn.onLoadingChange = (loading: boolean) => {
      if (this.connections.get(channelId) !== conn) return;
      playbackStore.getState().setChannelLoading(channelId, loading);
    };

    conn.onStalled = () => {
      if (this.connections.get(channelId) !== conn) return;
      this.connections.delete(channelId);
      this.releaseChannelSession(channelId);
      this.resyncPendingAfterAttach.delete(channelId);
      conn.close();
      // Reopen from current UI time, not dayStart. Read meta and playhead
      // at fire time — closure-captured startTime/endTime/mode could be
      // stale by now (day switch, mode upgrade).
      const meta = this.channelMeta.get(channelId);
      if (!meta) return;
      const now = playbackStore.getState().currentTime;
      const reopenStart =
        now > 0 && now >= meta.startTime && now <= meta.endTime
          ? now
          : meta.startTime;
      this.openOne(channelId, meta.mode, reopenStart, meta.endTime);
    };

    // Pick the freshest start: live UI playhead > currentStart > closure
    // startTime. currentStart only advances on openAll/seekAll/reconcile,
    // not natural playback, so a stall minutes in would otherwise reopen
    // at the original openAll time.
    const liveTime = playbackStore.getState().currentTime;
    const effectiveStart =
      liveTime != null && liveTime > 0
        ? Math.floor(liveTime)
        : this.currentStart ?? startTime;
    const effectiveSeek =
      liveTime != null && liveTime > 0
        ? unixToUtcTimeStr(Math.floor(liveTime))
        : this.currentSeekTimeStr ?? initialSeekTime;

    // Coverage might have slipped into a gap during the await.
    // reconcileCoverage is a no-op pre-set, so enforce here.
    if (!this.isChannelCoveredAtTime(channelId, effectiveStart)) {
      this.coverageByChannel.set(channelId, false);
      playbackStore.getState().setChannelLoading(channelId, false);
      // Release the reserved slot — reconcileCoverage will re-acquire
      // when the playhead re-enters coverage.
      this.releaseChannelSession(channelId);
      return;
    }

    conn.setSpeed(this.currentSpeed);
    conn.setHqMode(this.effectiveHqFor(channelId));
    conn.open(session.host, session.sessionId, sink, effectiveStart, endTime, effectiveSeek);
    this.connections.set(channelId, conn);
  }

  /** Returns the current HQ user preference. Injected so nvr/ modules
   *  don't pull in expo-file-system-backed stores that break Node-based
   *  unit tests. (currentTime is read directly off playbackStore — that
   *  store is plain zustand and safe to import here.) */
  private getHqMode: () => boolean = () => false;
  setHqModeProvider(fn: () => boolean): void {
    this.getHqMode = fn;
  }
}

export const playbackManager = PlaybackManager.getInstance();
export { PlaybackManager };
