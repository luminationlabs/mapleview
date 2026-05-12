import { login } from "./login";
import type { NvrSession } from "./types";
import { debugLog } from "../utils/debug-log";

export const MAX_STREAMS_PER_SESSION = 6;

export interface SessionPoolDeps {
  /** Number of active live streams (entries in NVRClient.streamSessions)
   *  using `session`. Combined with playback + live slot claims for a
   *  unified capacity check. */
  countActiveLiveStreams(session: NvrSession): number;
  /** Credentials for extra-session logins. Null if not yet connected. */
  getCredentials(): { host: string; userName: string; password: string } | null;
  /** Called once an extra-session login succeeds — gives the caller a
   *  chance to publish the freshest token (sessionStore + cached session). */
  onExtraSessionAcquired(session: NvrSession): void;
}

/**
 * Owns the inventory of NVR sessions and the slot accounting that lets
 * live + playback share the per-session cap. Stateless beyond its own
 * maps: external dependencies (login itself, store updates, credentials)
 * are injected via SessionPoolDeps so the pool stays testable in
 * isolation.
 */
export class SessionPool {
  private _primary: NvrSession | null = null;
  private extras: NvrSession[] = [];
  private pending: Promise<NvrSession | null>[] = [];

  /** Playback slot reservations per sessionId. Combined with active live
   *  streams + liveClaims for unified capacity. */
  private playbackClaims = new Map<string, number>();
  /** Live slot reservations per sessionId. Reserved synchronously by
   *  getAvailableSession before the caller opens its WS; released by
   *  every doOpen exit path. Without it, N concurrent attaches all see
   *  room and pile onto one session. */
  private liveClaims = new Map<string, number>();

  constructor(private readonly deps: SessionPoolDeps) {}

  setPrimary(session: NvrSession | null): void {
    this._primary = session;
  }

  get primary(): NvrSession | null {
    return this._primary;
  }

  /** Freshest session — latest extra if any, otherwise primary. Use for
   *  HTTP queries; new logins may invalidate older HTTP tokens. */
  get latest(): NvrSession | null {
    if (this.extras.length > 0) return this.extras[this.extras.length - 1];
    return this._primary;
  }

  /** Total streams (live + playback) using `session`. */
  private countFor(session: NvrSession): number {
    return (
      this.deps.countActiveLiveStreams(session) +
      (this.playbackClaims.get(session.sessionId) ?? 0) +
      (this.liveClaims.get(session.sessionId) ?? 0)
    );
  }

  private claimLive(session: NvrSession): void {
    const prev = this.liveClaims.get(session.sessionId) ?? 0;
    this.liveClaims.set(session.sessionId, prev + 1);
  }

  /** Release a live-slot claim. Called from every doOpen exit path
   *  before the slot transitions into streamSessions. No-op for an
   *  unknown sessionId. */
  releaseLiveSlot(session: NvrSession): void {
    const prev = this.liveClaims.get(session.sessionId) ?? 0;
    if (prev <= 1) {
      this.liveClaims.delete(session.sessionId);
    } else {
      this.liveClaims.set(session.sessionId, prev - 1);
    }
  }

  /** Reserve a session slot for a playback connection. Returns null if
   *  not connected; otherwise guarantees a session with one free slot
   *  and records the claim. Caller must releasePlaybackSlot when done. */
  async acquirePlaybackSlot(): Promise<NvrSession | null> {
    const session = await this.getAvailableSession();
    if (!session) return null;
    const prev = this.playbackClaims.get(session.sessionId) ?? 0;
    this.playbackClaims.set(session.sessionId, prev + 1);
    return session;
  }

  /** Release a playback-slot claim. No-op if the session is no longer tracked. */
  releasePlaybackSlot(session: NvrSession): void {
    const prev = this.playbackClaims.get(session.sessionId) ?? 0;
    if (prev <= 1) {
      this.playbackClaims.delete(session.sessionId);
    } else {
      this.playbackClaims.set(session.sessionId, prev - 1);
    }
  }

  /**
   * Find a session with capacity, or create/await one. Reserves a
   * live-slot claim synchronously so N concurrent callers see N-1
   * already-taken and distribute across sessions. Caller MUST
   * releaseLiveSlot on failure; success transfers to streamSessions.
   *
   * Loops so concurrent callers share in-flight logins — without the
   * loop, every overflow caller starts its own login and the NVR
   * rejects N parallel logins under load (doLogin: status=fail).
   */
  async getAvailableSession(): Promise<NvrSession | null> {
    if (!this._primary) return null;
    // Bound defensively — in practice ≤ ceil(N / cap) iterations.
    for (let iteration = 0; iteration < 10; iteration++) {
      if (this.countFor(this._primary) < MAX_STREAMS_PER_SESSION) {
        this.claimLive(this._primary);
        return this._primary;
      }
      for (const session of this.extras) {
        if (this.countFor(session) < MAX_STREAMS_PER_SESSION) {
          this.claimLive(session);
          return session;
        }
      }
      if (this.pending.length > 0) {
        await this.pending[0];
        continue;
      }
      // First overflow caller starts the login; later callers piggyback
      // via the branch above on their next iteration.
      const fresh = await this.startExtraLogin();
      if (!fresh) return null;
    }
    debugLog.warn("[session-pool] getAvailableSession exhausted retries");
    return null;
  }

  /** Force a fresh extra-session login. Recovers from the "silent-empty"
   *  failure: an HTTP query returns 200 + empty payload because the token
   *  was invalidated by a newer login. Doesn't disturb existing WS
   *  streams (they stay connected on original sessionIds). */
  refreshNow(): Promise<NvrSession | null> {
    return this.startExtraLogin();
  }

  /** Kick off an extra-session login. Resolves on completion (or null
   *  on failure); on success the session is pushed to extras.
   *  Parallel-safe — multiple concurrent logins yield distinct,
   *  immediately-usable sessions. */
  startExtraLogin(): Promise<NvrSession | null> {
    const creds = this.deps.getCredentials();
    if (!creds) return Promise.resolve(null);
    const { host, userName, password } = creds;
    const startedAt = Date.now();
    debugLog.info(`[session-pool] extra session login starting`);
    const promise: Promise<NvrSession | null> = (async () => {
      try {
        const newSession = await login(host, userName, password);
        this.extras.push(newSession);
        this.deps.onExtraSessionAcquired(newSession);
        debugLog.info(
          `[session-pool] extra session ready in ${Date.now() - startedAt}ms (total=${this.extras.length + 1})`,
        );
        return newSession;
      } catch (err) {
        debugLog.error(
          `[session-pool] extra session login failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    })();
    this.pending.push(promise);
    promise.finally(() => {
      const i = this.pending.indexOf(promise);
      if (i >= 0) this.pending.splice(i, 1);
    });
    return promise;
  }

  /** Pre-create enough sessions in parallel to cover `streamCount`
   *  streams. No-op if capacity (including pending logins) already
   *  suffices. Safe to call multiple times. */
  preloadFor(streamCount: number): void {
    const totalNeeded = Math.ceil(streamCount / MAX_STREAMS_PER_SESSION);
    const primary = this._primary ? 1 : 0;
    const have = primary + this.extras.length + this.pending.length;
    const toStart = Math.max(0, totalNeeded - have);
    if (toStart > 0) {
      debugLog.info(
        `[session-pool] preload: streams=${streamCount} need=${totalNeeded} have=${have} starting=${toStart}`,
      );
    }
    for (let i = 0; i < toStart; i++) {
      this.startExtraLogin();
    }
  }

  /** Await any in-flight extra session logins. HTTP-query callers should
   *  await this on a freshly-connected client — racing a completing
   *  extra login can fire a query on a token that's about to be
   *  invalidated server-side (silent-empty result, no error). */
  async awaitPendingLogins(): Promise<void> {
    if (this.pending.length === 0) return;
    await Promise.allSettled([...this.pending]);
  }

  /** Counts for diagnostics. */
  get extraCount(): number {
    return this.extras.length;
  }
  get pendingCount(): number {
    return this.pending.length;
  }

  /** closeAllStreams reset: drop extras, pending logins, and live-slot
   *  claims. Primary and playback claims survive (playback-manager owns
   *  its own claims; primary is re-validated by handleForeground). */
  resetForBackground(): void {
    this.extras = [];
    this.pending = [];
    // liveClaims should already be 0 — they're held only between
    // getAvailableSession and streamSessions.set, and any in-flight
    // holders self-abort on the openEpoch bump in NVRClient. Clear
    // defensively so race-induced remnants don't mislead future
    // capacity checks.
    this.liveClaims.clear();
  }
}
