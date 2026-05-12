import { login } from "./login";
import { SessionPool } from "./session-pool";
import { RecoveryClusterer } from "./recovery-clusterer";
import { StreamRegistry } from "./stream-registry";

// Lazy-loaded so vitest can resolve client.ts without expo-secure-store.
// Falls back to a noop cache when the module isn't resolvable.
type CredentialsModule = typeof import("../services/credentials");
let cachedCredentialsModule: CredentialsModule | null = null;
async function credentialsModule(): Promise<CredentialsModule> {
  if (cachedCredentialsModule) return cachedCredentialsModule;
  try {
    cachedCredentialsModule = await import("../services/credentials");
  } catch {
    cachedCredentialsModule = {
      loadCredentials: async () => null,
      loadHost: async () => null,
      saveCredentials: async () => undefined,
      clearCredentials: async () => undefined,
      loadCachedSession: async () => null,
      saveCachedSession: async () => undefined,
      clearCachedSession: async () => undefined,
    } as unknown as CredentialsModule;
  }
  return cachedCredentialsModule;
}
import type {
  CameraInfo,
  FrameSink,
  NvrSession,
  StreamMode,
} from "./types";
import { queryChlsExistRec, queryOnlineChlList } from "./xml";
import { sessionStore } from "../store/session-store";
import { cameraStore } from "../store/camera-store";
import { lifecycleStore } from "../store/lifecycle-store";
import { debugLog } from "../utils/debug-log";
// Circular dep with playback-manager — only used inside methods, never at
// module init, so both modules fully evaluate before either is invoked.
import { playbackManager } from "./playback-manager";

/** Normalize fast-xml-parser's `item` field — returns an object for one
 *  item, an array for multiple. */
function normalizeItems(
  content: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const items = content?.item;
  if (!items) return [];
  if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  return [items as Record<string, unknown>];
}

/** Backoff schedule in milliseconds, capped at 30s */
const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000];

function getBackoffDelay(attempt: number): number {
  return BACKOFF_SCHEDULE[Math.min(attempt, BACKOFF_SCHEDULE.length - 1)];
}

/** Distinguish a real NVR auth rejection (bad password) from transport
 *  problems. login() throws "doLogin: ..." or "doLogin failed: ..." when
 *  the NVR actively rejects the password hash; anything else is transport. */
export function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.startsWith("doLogin:") || err.message.startsWith("doLogin failed:");
}

/** Singleton NVR client: login, camera enumeration, stream pool. */
class NVRClient {
  private static instance: NVRClient | null = null;

  /** Session inventory + slot accounting. Owns primary, extras, pending
   *  logins, playback/live slot claims, and the getAvailableSession loop.
   *
   *  Initialized before `streams` so that field's deps can reference
   *  `this.sessions`. The countActiveLiveStreams callback closes over
   *  `this` and only runs at call time, so referencing `this.streams`
   *  (initialized below) from inside it is fine. */
  private readonly sessions: SessionPool = new SessionPool({
    countActiveLiveStreams: (session) => this.streams.countActiveLiveStreams(session),
    getCredentials: () => {
      if (!this._host || !this._userName || !this._password) return null;
      return { host: this._host, userName: this._userName, password: this._password };
    },
    onExtraSessionAcquired: (session) => {
      // Publish freshest token — older HTTP tokens may be stale
      // server-side. Existing WS connections survive (probe 02).
      sessionStore.getState().setSession(session);
      if (this._host && this._userName) {
        const host = this._host;
        const userName = this._userName;
        credentialsModule()
          .then((m) => m.saveCachedSession(host, userName, session))
          .catch(() => {});
      }
    },
  });

  /** Detects clustered failures (give-ups, pre-frame WS closes) and
   *  auto-triggers hardRetry to recover from stale-session conditions.
   *  Initialized before `streams` since the registry's deps reference it. */
  private readonly recovery: RecoveryClusterer = new RecoveryClusterer({
    isRecoveryInProgress: () => this.reconnectActive || this.hardRetryInFlight !== null,
    triggerHardRetry: () => this.hardRetry(),
  });

  /** Live-stream lifecycle: per-key StreamConnection instances, sink
   *  registry, detach grace timers, retry chain. */
  private readonly streams: StreamRegistry = new StreamRegistry({
    sessions: this.sessions,
    recovery: this.recovery,
    getOpenEpoch: () => this.openEpoch,
    getHqMode: () => this.hqModeProvider?.() ?? true,
    kickReconnectIfStranded: () => {
      const s = sessionStore.getState();
      const alreadyTrying = s.connecting || this.reconnectActive;
      if (!alreadyTrying && this._host && this._userName && this._password) {
        this.startReconnect();
      }
    },
  });

  /** In-flight primary connect(). Parallel connects race the NVR's
   *  single-session policy (the second login invalidates the first →
   *  loser throws `doLogin: ...` → isAuthFailure pops onboarding even
   *  though the winner succeeded). Coalesce instead. */
  private connectInFlight: Promise<void> | null = null;

  /** Bumped on closeAllStreams / handleForeground. StreamRegistry
   *  reads this via getOpenEpoch and self-aborts in-flight opens when
   *  it advances. */
  private openEpoch = 0;

  /** Credentials stored for reconnect / auth recovery. */
  private _host: string | null = null;
  private _userName: string | null = null;
  private _password: string | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectActive = false;

  /** User's HQ preference. Read at open time by StreamRegistry to pick
   *  stream_index (1 = 4K main, 2 = sub 704×480). */
  private hqModeProvider: (() => boolean) | null = null;

  /** Bounded timer that clears cameraStore.reconnecting after the reopen
   *  wave has had time to land. Without this, per-tile 'failed' overlays
   *  flash through during what's still the reconnect window. */
  private shroudClearTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SHROUD_HOLD_MS = 3000;

  private armShroudClear(): void {
    if (this.shroudClearTimer) clearTimeout(this.shroudClearTimer);
    this.shroudClearTimer = setTimeout(() => {
      this.shroudClearTimer = null;
      cameraStore.getState().setReconnecting(false);
    }, NVRClient.SHROUD_HOLD_MS);
  }


  /** External credential loader for auth recovery. */
  private credentialLoader:
    | (() => Promise<{
        host: string;
        username: string;
        password: string;
      } | null>)
    | null = null;

  private constructor() {}

  static getInstance(): NVRClient {
    if (!NVRClient.instance) {
      NVRClient.instance = new NVRClient();
    }
    return NVRClient.instance;
  }

  static resetForTesting(): void {
    if (NVRClient.instance) {
      NVRClient.instance.stopReconnect();
      NVRClient.instance.disconnect();
    }
    NVRClient.instance = null;
  }

  /** Test-only: seed primary session + credentials without running
   *  connect() (which would do real HTTP enumeration). */
  primeSessionForTesting(session: NvrSession, host: string, userName: string, password: string): void {
    this.sessions.setPrimary(session);
    this._host = host;
    this._userName = userName;
    this._password = password;
    sessionStore.getState().setSession(session);
  }

  setCredentialLoader(
    loader: () => Promise<{
      host: string;
      username: string;
      password: string;
    } | null>,
  ): void {
    this.credentialLoader = loader;
  }

  /** Install the HQ preference provider — called once from the root layout
   *  so StreamConnections can pick stream_index at open time. Call
   *  liveHqModeChanged() after a toggle to reopen affected streams. */
  setHqModeProvider(fn: () => boolean): void {
    this.hqModeProvider = fn;
  }

  /** Reopen every active main-mode stream so a flipped HQ pref takes
   *  effect (stream_index is fixed at open). Sub streams are unaffected. */
  liveHqModeChanged(): void {
    this.streams.liveHqModeChanged();
  }

  /** Login, enumerate cameras, populate stores. Coalesces onto an
   *  in-flight connect — see connectInFlight for why parallel logins
   *  falsely trigger authFailed. */
  async connect(
    host: string,
    userName: string,
    password: string,
  ): Promise<void> {
    if (this.connectInFlight) {
      return this.connectInFlight;
    }
    this.connectInFlight = this.runConnect(host, userName, password);
    try {
      await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  private async runConnect(
    host: string,
    userName: string,
    password: string,
  ): Promise<void> {
    this._host = host;
    this._userName = userName;
    this._password = password;

    sessionStore.getState().setConnecting(true);
    try {
      const creds = await credentialsModule();

      // Fresh primary login on every connect. We persist via
      // saveCachedSession but don't currently restore on cold launch —
      // see docs/session-probes.md for context on cached-session HTTP 400s.
      const session = await login(host, userName, password);
      this.sessions.setPrimary(session);
      sessionStore.getState().setSession(session);
      creds.saveCachedSession(host, userName, session).catch(() => {});

      const cameras = await this.enumerateCameras(session);
      // Don't wipe an existing non-empty list with an empty enumerate —
      // a fresh session sometimes returns [] transiently.
      const existingCount = cameraStore.getState().cameras.length;
      if (cameras.length > 0 || existingCount === 0) {
        cameraStore.getState().setCameras(cameras);
      }

      // Preload extra sessions in parallel with the first batch of stream
      // opens. Sized for the Live-tab grid; Recorded adds demand which
      // getAvailableSession satisfies on-demand.
      this.preloadSessionsFor(cameraStore.getState().cameras.length);
      this.stopReconnect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sessionStore.getState().setError(msg);
      throw err;
    }
  }

  /** Disconnect: close all streams, clear stores, stop reconnect. */
  disconnect(): void {
    this.stopReconnect();
    // User-initiated disconnect → invalidate the session cache so we
    // don't silently reuse the old session on next launch.
    credentialsModule()
      .then((m) => m.clearCachedSession())
      .catch(() => {});

    this.streams.closeAll({ clearSinks: true });
    if (this.shroudClearTimer) {
      clearTimeout(this.shroudClearTimer);
      this.shroudClearTimer = null;
    }
    this.sessions.resetForBackground();
    this.sessions.setPrimary(null);

    sessionStore.getState().clearSession();
    cameraStore.getState().clear();
  }

  /** Attach a frame sink to a channel stream. */
  attach(channelId: string, mode: StreamMode, sink: FrameSink): void {
    this.streams.attach(channelId, mode, sink);
  }

  /** Detach with a grace period. Re-attach within DETACH_GRACE_MS reuses
   *  the connection without close/reopen. */
  detach(channelId: string, mode: StreamMode): void {
    this.streams.detach(channelId, mode);
  }

  /** Reserve a session slot for a playback connection. Single entry point
   *  for playback-manager. Returns null if not logged in; otherwise
   *  guarantees a session with one free slot and records the claim. */
  acquirePlaybackSlot(): Promise<NvrSession | null> {
    return this.sessions.acquirePlaybackSlot();
  }

  releasePlaybackSlot(session: NvrSession): void {
    this.sessions.releasePlaybackSlot(session);
  }

  /** Force a fresh extra-session login. Recovers from the "silent-empty"
   *  failure: an HTTP query returns 200 + empty payload because the token
   *  was invalidated by a newer login. Doesn't disturb existing WS
   *  streams (they stay connected on original sessionIds). */
  refreshSessionNow(): Promise<NvrSession | null> {
    return this.sessions.refreshNow();
  }

  /** Pre-create enough sessions in parallel to cover `streamCount`
   *  streams. No-op if capacity already suffices. */
  preloadSessionsFor(streamCount: number): void {
    this.sessions.preloadFor(streamCount);
  }

  /** Await any in-flight extra session logins. HTTP-query callers should
   *  await this on a freshly-connected client — racing a completing
   *  extra login can fire a query on a token that's about to be
   *  invalidated server-side (silent-empty result, no error). */
  awaitPendingLogins(): Promise<void> {
    return this.sessions.awaitPendingLogins();
  }

  get isConnected(): boolean {
    return this.sessions.primary !== null;
  }

  get session(): NvrSession | null {
    return this.sessions.primary;
  }

  /** Most recently created session — use for HTTP queries. Extra logins
   *  may invalidate older HTTP tokens (existing WS connections survive). */
  get latestSession(): NvrSession | null {
    return this.sessions.latest;
  }

  // --------------- Reconnect with exponential backoff ---------------

  /** Start the reconnect backoff loop. */
  startReconnect(): void {
    if (this.reconnectActive) return;
    if (!this._host || !this._userName || !this._password) return;

    this.reconnectActive = true;
    this.sessions.setPrimary(null);
    const state = sessionStore.getState();
    if (state.connected) {
      sessionStore.getState().clearSession();
    }
    sessionStore.getState().setReconnecting(true, 0);

    this.scheduleReconnectAttempt(0);
  }

  stopReconnect(): void {
    this.reconnectActive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    sessionStore.getState().setReconnecting(false, 0);
  }

  /** Manually trigger a reconnect attempt. Compatibility shim — UI
   *  retry buttons and auto-recovery now call hardRetry (a strict
   *  superset). Prefer hardRetry in new code. */
  async retryNow(): Promise<void> {
    if (!this._host || !this._userName || !this._password) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectActive = true;
    const ok = await this.attemptReconnect();
    if (!ok) {
      // Clear active on failure so a subsequent retry can fire.
      // Otherwise the flag stays pinned and future callers see "already
      // trying" with no path to recover until app-background.
      this.reconnectActive = false;
    }
  }

  private scheduleReconnectAttempt(attempt: number): void {
    if (!this.reconnectActive) return;

    const delay = getBackoffDelay(attempt);
    sessionStore.getState().setReconnecting(true, attempt + 1);

    this.reconnectTimer = setTimeout(async () => {
      if (!this.reconnectActive) return;
      const success = await this.attemptReconnect();
      if (!success && this.reconnectActive) {
        this.scheduleReconnectAttempt(attempt + 1);
      }
    }, delay);
  }

  private async attemptReconnect(): Promise<boolean> {
    if (!this._host || !this._userName || !this._password) return false;

    try {
      await this.connect(this._host, this._userName, this._password);
      this.streams.reopenAll();
      return true;
    } catch (err) {
      if (isAuthFailure(err)) {
        // Real auth rejection — stop the loop and pop the onboarding
        // modal. Retrying a bad password on a schedule just spam-logs
        // the NVR's auth backend.
        this.stopReconnect();
        sessionStore.getState().setAuthFailed(true);
      }
      return false;
    }
  }

  // --------------- Auth recovery ---------------

  /** Silent re-authentication using stored credentials. */
  async attemptAuthRecovery(): Promise<boolean> {
    let host = this._host;
    let userName = this._userName;
    let password = this._password;

    if (this.credentialLoader) {
      try {
        const creds = await this.credentialLoader();
        if (creds) {
          host = creds.host;
          userName = creds.username;
          password = creds.password;
        }
      } catch {
        // Fall through to stored creds
      }
    }

    if (!host || !userName || !password) {
      // No credentials stored — fresh install / post-logout, not a
      // failed login. Onboarding is presented elsewhere; setting
      // authFailed here would stack a second modal.
      return false;
    }

    // 3 fast retries cover the typical post-unlock Wi-Fi reassociation
    // window. setReconnecting suppresses transient per-attempt error
    // flashes so users only see the final state.
    sessionStore.getState().setReconnecting(true);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.connect(host, userName, password);
        return true;
      } catch (err) {
        lastError = err;
        if (isAuthFailure(err)) break;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    if (isAuthFailure(lastError)) {
      sessionStore.getState().setAuthFailed(true);
    } else {
      // Transport failure — hand off to the backoff loop (self-healing).
      this.startReconnect();
    }
    return false;
  }

  // --------------- App lifecycle ---------------

  /** Close all streaming WebSockets without clearing the sink registry.
   *  Called on background > 5s. sinkRegistry is preserved so the next
   *  foreground reopen (via streams.reopenAll) can restore. */
  closeAllStreams(): void {
    debugLog.info(
      `[client] closeAllStreams: streams=${this.streams.size} extras=${this.sessions.extraCount} pending=${this.streams.pendingRetryCount}`,
    );
    // Mark reconnecting before teardown so connection-close-triggered
    // "failed" flips are suppressed in the UI.
    cameraStore.getState().setReconnecting(true);
    // Cancel a pending shroud-clear from a prior cycle so it can't
    // clear the shroud we just set. handleForeground re-arms.
    if (this.shroudClearTimer) {
      clearTimeout(this.shroudClearTimer);
      this.shroudClearTimer = null;
    }
    // Invalidate in-flight scheduleOpen() calls so they self-abort at
    // their next await rather than displacing valid fresh connections.
    this.openEpoch++;
    this.streams.closeAll();

    // Discard extra sessions — after >5s background the OS has likely
    // killed the TCP sockets, and the NVR may have idle-timed-out the
    // HTTP session. getAvailableSession re-logins as needed on
    // foreground. Primary stays for handleForeground to re-validate.
    this.sessions.resetForBackground();
  }

  /** Resolves when handleForeground has validated the primary session.
   *  Playback opens that race handleForeground MUST await this — otherwise
   *  they may acquire slots on a stale primary whose WS upgrades 400. */
  private foregroundReadyPromise: Promise<void> = Promise.resolve();
  awaitForegroundReady(): Promise<void> {
    return this.foregroundReadyPromise;
  }

  /** In-flight handleForeground promise. iOS commonly bounces unlock
   *  through inactive→active→inactive→active, firing parallel
   *  handleForegrounds. Concurrent recoveries used to race on _session —
   *  coalesce instead. */
  private foregroundInFlight: Promise<void> | null = null;

  handleForeground(): Promise<void> {
    if (this.foregroundInFlight) return this.foregroundInFlight;
    this.foregroundInFlight = this.runHandleForeground().finally(() => {
      this.foregroundInFlight = null;
    });
    return this.foregroundInFlight;
  }

  private async runHandleForeground(): Promise<void> {
    const startedAt = Date.now();
    // Capture sink count before the transition — by the epilogue, the
    // live grid may have mounted and grown sinks, but the reopen decision
    // should reflect pre-transition state.
    const initialSinkCount = this.streams.sinkCount;
    debugLog.info(
      `[client] handleForeground: sinks=${initialSinkCount} hadPrimary=${this.sessions.primary != null}`,
    );
    cameraStore.getState().setReconnecting(true);
    // Block external opens (especially playback-manager's parallel
    // handleForeground) until primary is validated. Resolved once
    // enumerateCameras + any auth recovery finish.
    let resolveReady: () => void = () => {};
    this.foregroundReadyPromise = new Promise((r) => {
      resolveReady = r;
    });
    // Invalidate in-flight / pre-background retry scheduleOpens.
    this.openEpoch++;
    this.streams.cancelPendingRetries();
    try {
      if (!this.sessions.primary) {
        const recovered = await this.attemptAuthRecovery();
        if (!recovered) return;
      }

      let primary = this.sessions.primary;
      if (!primary) return;

      const hadCameras = cameraStore.getState().cameras.length > 0;
      let fresh: CameraInfo[] | null = null;
      try {
        fresh = await this.enumerateCameras(primary);
      } catch (err) {
        debugLog.warn(
          `[client] handleForeground: enumerate failed — ${err instanceof Error ? err.message : String(err)}`,
        );
        fresh = null;
      }

      // Treat empty result as stale-session when we had cameras —
      // recover rather than briefly rendering "No cameras available".
      if (fresh === null || (fresh.length === 0 && hadCameras)) {
        debugLog.warn(
          `[client] handleForeground: enumerate returned ${fresh === null ? "null" : "empty"} — authRecovery`,
        );
        const recovered = await this.attemptAuthRecovery();
        if (!recovered) return;
        primary = this.sessions.primary;
        if (!primary) return;
        try {
          fresh = await this.enumerateCameras(primary);
        } catch {
          return;
        }
      }

      if (fresh.length > 0 || !hadCameras) {
        cameraStore.getState().setCameras(fresh);
      }

      // Primary validated. Unblock parallel openers BEFORE preloading
      // so playback-manager's awaiting openOnes can run in parallel.
      resolveReady();

      // Sized for the visible-tab grid; Recorded reopens trigger
      // on-demand extra logins via getAvailableSession.
      this.preloadSessionsFor(
        cameraStore.getState().cameras.length,
      );

      // Cold-launch path: handleForeground can fire before any sinks
      // attach. Skipping reopenAll then avoids tearing down mid-upgrade
      // WSes (existing.isAlive=false at ~50ms post-open), which would
      // hold NVR slots and force the pool to over-spawn extras.
      if (initialSinkCount > 0) {
        this.streams.reopenAll();
        debugLog.info(
          `[client] handleForeground: reopen dispatched in ${Date.now() - startedAt}ms`,
        );
      } else {
        debugLog.info(
          `[client] handleForeground: cold-launch path, skip reopenAll (${Date.now() - startedAt}ms)`,
        );
      }
    } finally {
      // Ensure waiters unblock on error fallthroughs above.
      resolveReady();
      this.armShroudClear();
    }
  }

  private hardRetryInFlight: Promise<boolean> | null = null;

  /**
   * Full teardown + fresh reconnect — force-quit + relaunch semantics
   * while preserving navigation state. From user Retry buttons when
   * normal recovery hasn't succeeded.
   *
   * Vs retryNow(): also clears live + playback connections, extras,
   * slot accounting, the primary session reference (forces fresh
   * login), and native display-layer stale frames (via foregroundEpoch).
   */
  async hardRetry(): Promise<boolean> {
    if (this.hardRetryInFlight) return this.hardRetryInFlight;
    this.hardRetryInFlight = this.runHardRetry().finally(() => {
      this.hardRetryInFlight = null;
    });
    return this.hardRetryInFlight;
  }

  private async runHardRetry(): Promise<boolean> {
    if (!this._host || !this._userName || !this._password) {
      debugLog.warn("[client] hardRetry: no credentials — skipping");
      return false;
    }

    debugLog.warn("[client] hardRetry: full teardown + reconnect");

    this.closeAllStreams();
    // Preserves channelMeta and sinks so handleForeground can restore.
    playbackManager.handleBackground();

    // Force a fresh primary login. "Retry doesn't work but force-quit
    // does" is specifically the stale-session case: HTTP succeeds but
    // WS upgrades return HTTP 400.
    this.sessions.setPrimary(null);
    sessionStore.getState().clearSession();

    // Flush every NvrVideoView's display layer so stale frames clear
    // while fresh opens are in flight.
    lifecycleStore.getState().bumpForegroundEpoch();

    this.reconnectActive = true;
    const ok = await this.attemptReconnect();
    if (!ok) {
      this.reconnectActive = false;
      debugLog.error("[client] hardRetry: fresh login failed");
      // Clear the shroud even on failure so the UI doesn't stay stuck
      // in "connecting". attemptReconnect already set authFailed if
      // applicable.
      this.armShroudClear();
      return false;
    }

    // No-op if user isn't on Recorded (channelMeta was cleared on blur).
    playbackManager.handleForeground();

    this.armShroudClear();

    debugLog.info("[client] hardRetry: complete");
    return true;
  }

  private async enumerateCameras(session: NvrSession): Promise<CameraInfo[]> {
    const [chlResp, onlineResp] = await Promise.all([
      queryChlsExistRec(session.host, session.token, session.sessionId),
      queryOnlineChlList(session.host, session.token, session.sessionId),
    ]);

    const chlItems = normalizeItems(chlResp.content);
    const onlineItems = normalizeItems(onlineResp.content);
    const onlineIds = new Set(
      onlineItems.map((item) => String(item["@_id"] ?? "")),
    );

    const cameras: CameraInfo[] = chlItems.map((item) => {
      const channelId = String(item["@_id"] ?? "");
      const name = String(item["#text"] ?? item["__cdata"] ?? "Unknown");
      const online = onlineIds.has(channelId);

      return {
        channelId,
        name,
        status: online ? ("online" as const) : ("offline" as const),
      };
    });

    return cameras;
  }
}

export const nvrClient = NVRClient.getInstance();
export { NVRClient };
