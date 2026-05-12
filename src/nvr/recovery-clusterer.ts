import { debugLog } from "../utils/debug-log";

export interface RecoveryClustererDeps {
  /** Skip auto-recovery if a manual reconnect or hardRetry is already
   *  in flight. */
  isRecoveryInProgress(): boolean;
  /** Trigger a hardRetry. Resolves when the retry completes. */
  triggerHardRetry(): Promise<unknown>;
}

/**
 * Detects clustered failures that signal a recoverable systemic problem
 * (stale session, NVR reboot) and auto-triggers a hardRetry before the
 * per-channel retry chains exhaust — so a recoverable failure doesn't
 * paint every tile red.
 *
 * Two signals:
 *
 *   Give-ups: streams whose 3-retry chain exhausted. ≥5 in 5s →
 *   recovery. Slower to trigger but unambiguous.
 *
 *   Pre-frame WS closes: WS upgrades that closed before any video
 *   arrived. The proxy signal for stale-session HTTP 400 (JS' WebSocket
 *   API hides the upgrade status). ≥3 in 3s → recovery, sooner than
 *   give-up clustering can detect.
 *
 * A 30s cooldown between recoveries prevents login churn on persistent
 * failures (the user can still manually hardRetry in that window).
 */
export class RecoveryClusterer {
  private static readonly GIVEUP_CLUSTER_WINDOW_MS = 5000;
  // 5 give-ups within the window. Lower values tripped on benign
  // scenarios (e.g. 3 legitimately-offline cameras).
  private static readonly GIVEUP_CLUSTER_THRESHOLD = 5;

  private static readonly PREFRAME_CLUSTER_WINDOW_MS = 3000;
  // Triggers sooner than give-up clustering (3 retries per channel ≈ 9s)
  // so we recover from stale-session-on-upgrade within ~1-2s.
  private static readonly PREFRAME_CLUSTER_THRESHOLD = 3;

  private static readonly AUTO_RETRY_COOLDOWN_MS = 30_000;

  private recentGiveUps: number[] = [];
  private recentPreFrameCloses: number[] = [];
  private lastAutoRetryAt = 0;
  private autoRetryInFlight = false;

  constructor(private readonly deps: RecoveryClustererDeps) {}

  /** Called when a stream gives up (retry chain exhausted). */
  noteGiveUp(): void {
    const now = Date.now();
    this.recentGiveUps = this.recentGiveUps.filter(
      (t) => now - t < RecoveryClusterer.GIVEUP_CLUSTER_WINDOW_MS,
    );
    this.recentGiveUps.push(now);
    if (this.recentGiveUps.length < RecoveryClusterer.GIVEUP_CLUSTER_THRESHOLD) return;
    this.trigger(`${RecoveryClusterer.GIVEUP_CLUSTER_THRESHOLD}+ streams gave up`);
  }

  /** Called on every pre-frame WS close — the stale-session-on-upgrade
   *  signal. */
  notePreFrameClose(): void {
    const now = Date.now();
    this.recentPreFrameCloses = this.recentPreFrameCloses.filter(
      (t) => now - t < RecoveryClusterer.PREFRAME_CLUSTER_WINDOW_MS,
    );
    this.recentPreFrameCloses.push(now);
    if (this.recentPreFrameCloses.length < RecoveryClusterer.PREFRAME_CLUSTER_THRESHOLD) return;
    this.trigger(`${RecoveryClusterer.PREFRAME_CLUSTER_THRESHOLD}+ pre-frame WS closes`);
  }

  private trigger(reason: string): void {
    const now = Date.now();
    if (this.autoRetryInFlight) return;
    if (this.deps.isRecoveryInProgress()) return;
    if (now - this.lastAutoRetryAt < RecoveryClusterer.AUTO_RETRY_COOLDOWN_MS) return;
    this.recentGiveUps = [];
    this.recentPreFrameCloses = [];
    this.lastAutoRetryAt = now;
    this.autoRetryInFlight = true;
    debugLog.warn(`[client] auto-recover: ${reason} — hardRetry`);
    this.deps.triggerHardRetry().finally(() => {
      this.autoRetryInFlight = false;
    });
  }
}
