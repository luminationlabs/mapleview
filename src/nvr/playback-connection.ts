import { generateTaskId } from "./guid";
import { parseSHFL } from "./shfl";
import type { FrameSink, StreamMode } from "./types";
import { parseWSFrame } from "./ws-frame";
import { wsUrl } from "../utils/parse-host";

/** Speeds above this use keyframe-only mode (1–4× all-frame, 8× keyframe-only).
 *  Keyframe-mode ACK pacing is tuned for 8×; lowering this reintroduces
 *  burst/pause oscillation. */
const KEYFRAME_MODE_SPEED_THRESHOLD = 4;
/** Speeds at or below this allow HQ main-stream playback (stream_index 0,
 *  4K H.265). Above this, main-mode is forced to stream 1 — the NVR can't
 *  sustain 4K keyframe delivery at 4×+ over WiFi. */
const MAX_HQ_SPEED = 1;

/**
 * Outcome of an in-place seek attempt.
 *   ok         — server honored all_frame and the next IDR's PTS matched.
 *   mismatch   — next IDR landed far from target; server likely ignored seek.
 *   timeout    — no IDR arrived within the verification window.
 *   superseded — a newer seekInPlace() replaced this one; the newer call
 *                now owns the in-flight state, so the caller should NOT
 *                fall back (it would race the newer seek).
 */
export type SeekInPlaceResult = "ok" | "mismatch" | "timeout" | "superseded";

function randomUint32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** All recording type filters for playback/open. */
const TYPE_MASK = [
  "manual",
  "sensor",
  "avd",
  "smart_pass_line",
  "tripwire",
  "perimeter",
  "smart_aoi_entry",
  "smart_aoi_leave",
  "motion",
  "pos",
  "schedule",
];

/** Flow control: send refresh_play_index every N decoded video frames. */
const FLOW_CONTROL_INTERVAL = 8;

/**
 * Manages a single WebSocket playback connection to an NVR channel.
 *
 * Lifecycle: open() → playback/open with time range → SHFL frames → sink;
 * every FLOW_CONTROL_INTERVAL frames we ACK; close() ends the task.
 * Supports seeking (all_frame), pause/resume (toggling flow control), and
 * speed changes.
 */
export class PlaybackConnection {
  readonly channelId: string;
  readonly mode: StreamMode;
  /** Current playback task_id. Rotated on restart so responses bind to the active task. */
  taskId: string;

  private ws: WebSocket | null = null;
  private sink: FrameSink | null = null;
  private alive = false;
  private paused = false;
  private receivedFirstFrame = false;

  private frameCount = 0;
  private lastSentIndex = 0;
  /**
   * Server-assigned frame index from the most recent SHFL frame. We echo
   * this back as refresh_play_index — getting it wrong (e.g. using a
   * client-side counter) hangs 8× keyframe-only streams after ~3 frames.
   */
  private lastSeq = 0;
  private lastPts = 0;

  /** Playback speed multiplier (1, 2, 4, 8). Scales ACK pacing. */
  private speed = 1;
  /** Whether the server is currently emitting keyframes only. Above 4× the
   *  NVR can't deliver every frame for every channel. */
  private isKeyFrameMode = false;
  /** Absolute wall-clock ms for the next paced ACK fire (0 = needs re-anchor).
   *  Absolute scheduling keeps cadence locked to targetGap even when
   *  setTimeout is jittery. */
  private nextAckWall = 0;
  private ackScheduled = false;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * All-frame ACK pacing:
   *   targetGap = FRAMES_PER_ACK_ALL_FRAME × observedPtsPerFrame / speed
   * Per-connection because cameras can have different fps. We track MIN
   * of a sliding window, not EMA: drops only inflate deltas, never
   * shorten them, so MIN is robust to drops. EMA drifted ~20% high.
   */
  private static readonly FRAMES_PER_ACK_ALL_FRAME = 32;
  /** Conservative 30fps guess used until we've observed actual frame rate. */
  private static readonly DEFAULT_PTS_PER_FRAME_MS = 33.3;
  private static readonly ACK_GAP_MIN_MS = 100;
  private static readonly ACK_GAP_MAX_MS = 5000;
  private static readonly FRAME_DELTA_SAMPLE_SIZE = 20;
  private recentFrameDeltas: number[] = [];
  private observedPtsPerFrameMs: number | null = null;

  /** Observed GOP (interval between keyframes, sec). Median of recent
   *  keyframe-to-keyframe PTS deltas. NVR releases ~3 keyframes per ACK
   *  in keyframe-only mode; targetGap = framesPerAck × GOP / speed.
   *  Reset on every restart. */
  private observedGopSec: number | null = null;
  private prevKeyframePts: number | null = null;
  private recentGopSamples: number[] = [];
  private static readonly GOP_SAMPLE_SIZE = 5;
  private static readonly FRAMES_PER_ACK_KEYFRAME_MODE = 3;

  /**
   * Shared pacing baseline: the playback target time (unix sec) at the
   * wall-clock moment the user seeked. All connections pace to the SAME
   * expected time so late-loading cameras don't drift and cross-camera
   * sync stays tight.
   *
   * PTS in frames is Windows FILETIME (100-ns since 1601-01-01 UTC):
   *   unix = pts / 10_000_000 - FILETIME_UNIX_OFFSET_SEC
   */
  private static sharedSeekUnix = 0;
  private static sharedSeekWall = 0;
  private static readonly FILETIME_UNIX_OFFSET_SEC = 11644473600;
  static setPacingBaseline(seekUnix: number): void {
    PlaybackConnection.sharedSeekUnix = seekUnix;
    PlaybackConnection.sharedSeekWall = Date.now();
  }
  static resetSharedPacing(): void {
    PlaybackConnection.sharedSeekUnix = 0;
    PlaybackConnection.sharedSeekWall = 0;
  }
  /** Pause ACKs when PTS runs ahead of wall clock so the server's
   *  flow-control window fills. Resume timer fires when wall clock
   *  catches up. See docs/playback-pacing-log.md. */
  private pacingPauseTimer: ReturnType<typeof setTimeout> | null = null;
  private pacedPaused = false;
  // CMTimebase + explicit sample duration paces display correctly for
  // ~5–10s before the display layer's internal buffer overflows. 5s
  // keeps us inside that proven-smooth window.
  private static readonly PACING_LEAD_MS = 5000;

  onConnectionFailed: (() => void) | null = null;
  onStalled: (() => void) | null = null;
  /** Fires when the keyframe-wait gate opens or closes. UI shows a
   *  spinner during transitions instead of decoder green-screen. */
  onLoadingChange: ((loading: boolean) => void) | null = null;

  private static readonly STALL_TIMEOUT_MS = 15_000;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  private startTime = 0;
  private endTime = 0;
  /** Optional sub-second seek to apply via all_frame after playback/open. */
  private initialSeekTime: string | null = null;

  /** Drop frames until next keyframe. Set on restart() to suppress
   *  pre-restart stragglers (mid-GOP P-frames break the decoder's reference
   *  chain → green flash). Cleared on keyframe arrival or
   *  KEYFRAME_WAIT_TIMEOUT_MS fallback. */
  private waitingForKeyframe = false;
  private keyframeWaitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Synchronous frame-drop gate. Set by restart() before the async run()
   * rotates taskId, so stale frames from the pre-restart task can't
   * pollute lastPts / sharedSeekUnix / the sink during the microtask
   * window. Cleared inside runRestart() once taskId rotates; the
   * task_id filter takes over from there.
   *
   * Without this, a forward scrub could let stale frames trigger the
   * scheduleFrameDelivery leadMs<-1000 re-align (since removed) and
   * roll sharedSeekUnix backward.
   */
  private seekDropActive = false;

  /** In-flight seekInPlace() bookkeeping. Next keyframe's PTS is compared
   *  against `expectedUnix`; mismatch means server ignored the all_frame
   *  and the caller should restart(). */
  private pendingSeekCheck: {
    expectedUnix: number;
    toleranceSec: number;
    resolve: (r: SeekInPlaceResult) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private static readonly IN_PLACE_SEEK_TIMEOUT_MS = 1000;
  private static readonly IN_PLACE_SEEK_TOLERANCE_SEC = 5;
  // GOPs in captures span ~5s; allow enough time for the first keyframe
  // of a new task to land before falling back.
  private static readonly KEYFRAME_WAIT_TIMEOUT_MS = 6000;

  private loadingState = false;
  private loadingWatchdog: ReturnType<typeof setTimeout> | null = null;
  private static readonly LOADING_WATCHDOG_MS = 5000;
  private setLoading(loading: boolean): void {
    if (this.loadingState !== loading) {
      this.loadingState = loading;
      this.onLoadingChange?.(loading);
    }
    // Always reset the watchdog. A setLoading(true) while already loading
    // is still a new "start of work" event (e.g. coalesced restart) and
    // deserves its own 5s budget.
    if (this.loadingWatchdog) {
      clearTimeout(this.loadingWatchdog);
      this.loadingWatchdog = null;
    }
    if (loading) {
      this.loadingWatchdog = setTimeout(() => {
        this.loadingWatchdog = null;
        if (this.loadingState && this.alive) {
          console.log(
            `[playback ${this.channelId.slice(1, 9)}] loading watchdog — reopening (no keyframe in ${PlaybackConnection.LOADING_WATCHDOG_MS}ms)`,
          );
          this.onStalled?.();
        }
      }, PlaybackConnection.LOADING_WATCHDOG_MS);
    }
  }

  constructor(channelId: string, mode: StreamMode) {
    this.channelId = channelId;
    this.mode = mode;
    this.taskId = generateTaskId();
  }

  /**
   * Open a WebSocket and start playback.
   *
   * @param host - NVR host (IP or hostname)
   * @param sessionId - Session ID from login
   * @param sink - Callback to receive decoded NAL units
   * @param startTime - Start of playback range (Unix sec UTC)
   * @param endTime - End of playback range (Unix sec UTC)
   */
  open(
    host: string,
    sessionId: string,
    sink: FrameSink,
    startTime: number,
    endTime: number,
    initialSeekTime: string | null = null,
  ): void {
    this.sink = sink;
    this.startTime = startTime;
    this.endTime = endTime;
    this.initialSeekTime = initialSeekTime;
    this.receivedFirstFrame = false;
    this.seekDropActive = false;
    this.setLoading(true);

    const url = wsUrl(host, `/requestWebsocketConnection?sessionID=${sessionId}`);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleTextMessage(event.data);
      } else {
        this.handleBinaryMessage(event.data as ArrayBuffer);
      }
    };

    ws.onerror = () => {
      this.alive = false;
      if (!this.receivedFirstFrame) {
        this.onConnectionFailed?.();
      }
    };

    ws.onclose = () => {
      this.alive = false;
    };
  }

  /**
   * In-place seek via /device/playback/all_frame on the existing WS — no
   * close/reopen. Re-arms the keyframe gate so stragglers don't reach
   * the decoder, then watches the next IDR: if its PTS is within
   * `toleranceSec` of `expectedUnix`, the seek worked; otherwise reports
   * mismatch so the caller can fall back to restart().
   *
   * @param frameTime     "YYYY-MM-DD HH:MM:SS:mmm" wire format
   * @param expectedUnix  Unix seconds we expect the next IDR to land near
   */
  async seekInPlace(
    frameTime: string,
    expectedUnix: number,
  ): Promise<SeekInPlaceResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return "timeout";

    // Supersede any previous pending check so its caller doesn't race
    // its fallback against this newer seek.
    if (this.pendingSeekCheck) {
      clearTimeout(this.pendingSeekCheck.timer);
      this.pendingSeekCheck.resolve("superseded");
      this.pendingSeekCheck = null;
    }

    this.resetPacing();
    this.waitingForKeyframe = true;
    this.receivedFirstFrame = false;
    // Stale prevKeyframePts produces a wrong delta on the first post-seek
    // keyframe and skews the GOP median. restart() resets it; so must we.
    this.resetGopObserver();
    // The pending ACK's targetGap was computed from pre-seek observations.
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
      this.ackScheduled = false;
    }
    this.nextAckWall = 0;

    // Match server-side mode to current speed (above 4× the NVR can't
    // sustain all-frame for every channel).
    const useKeyFrameMode = this.speed > KEYFRAME_MODE_SPEED_THRESHOLD;
    this.isKeyFrameMode = useKeyFrameMode;

    return new Promise<SeekInPlaceResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingSeekCheck && this.pendingSeekCheck.timer === timer) {
          this.pendingSeekCheck = null;
          resolve("timeout");
        }
      }, PlaybackConnection.IN_PLACE_SEEK_TIMEOUT_MS);

      this.pendingSeekCheck = {
        expectedUnix,
        toleranceSec: PlaybackConnection.IN_PLACE_SEEK_TOLERANCE_SEC,
        resolve,
        timer,
      };

      if (useKeyFrameMode) {
        this.sendKeyFrame(frameTime);
      } else {
        this.sendAllFrame(frameTime);
      }
    });
  }

  /** User-intent pause flag, distinct from `this.paused` (which is also
   *  toggled by the transient pacing-pause path). The pacing timer must
   *  not override a user pause, otherwise the server keeps streaming
   *  into a frozen timebase and the native queue fills. */
  private userPaused = false;

  /**
   * Pause playback by stopping flow control. The server stops delivering
   * once refresh_play_index stops arriving.
   *
   * Also clears the stall watchdog — no-frames-for-15s is the EXPECTED
   * state under pause, not a failure. Otherwise paused single-cam
   * channels cascade-reopen every 15s. resume() re-arms the watchdog.
   */
  pause(): void {
    this.paused = true;
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
      this.ackScheduled = false;
    }
    // Drop the schedule anchor; resume() re-anchors at `now + targetGap`
    // rather than catching up on skipped ACKs.
    this.nextAckWall = 0;
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * User-initiated pause/resume. Like pause()/resume() but additionally
   * clears any pending pacing-pause resume so it can't un-gate the server
   * during a user pause.
   */
  setUserPaused(paused: boolean): void {
    this.userPaused = paused;
    if (paused) {
      this.pause();
      if (this.pacingPauseTimer) {
        clearTimeout(this.pacingPauseTimer);
        this.pacingPauseTimer = null;
      }
      this.pacedPaused = false;
    } else {
      this.resume();
    }
  }

  /** Resume by re-enabling flow control. Sends refresh_play_index immediately. */
  resume(): void {
    this.paused = false;
    // All-frame mode requires ACKs on FLOW_CONTROL_INTERVAL multiples;
    // pause-flush can leave lastSentIndex on a non-multiple. Round up
    // to the next multiple strictly greater than lastSentIndex so the
    // server's flow-control cursor advances on resume.
    if (this.isKeyFrameMode) {
      this.doSendAck();
    } else {
      const nextIndex =
        Math.ceil((this.lastSentIndex + 1) / FLOW_CONTROL_INTERVAL) *
        FLOW_CONTROL_INTERVAL;
      this.sendAckWithIndex(nextIndex);
    }
    // Re-arm the stall watchdog — pause() cleared it. If the server
    // doesn't honor our resume ACK, the 15s watchdog should fire.
    if (this.receivedFirstFrame) this.resetStallTimer();
  }

  /**
   * Set playback speed. Returns true if the caller should also restart() —
   * crossing the keyframe-only threshold or HQ-eligibility boundary
   * requires a full close+open (the bare /key_frame switch is unreliable
   * mid-task on this NVR).
   */
  setSpeed(speed: number): boolean {
    // 1×↔2× doesn't flip keyframe mode but does flip HQ eligibility,
    // and we need to restart for that too.
    const prevStreamIndex = this.resolveStreamIndex();
    this.speed = speed > 0 ? speed : 1;
    const shouldKeyOnly = this.speed > KEYFRAME_MODE_SPEED_THRESHOLD;
    const keyframeModeChanged = shouldKeyOnly !== this.isKeyFrameMode;
    const streamIndexChanged = this.resolveStreamIndex() !== prevStreamIndex;
    return keyframeModeChanged || streamIndexChanged;
  }

  private pendingCloseAck: Promise<void> | null = null;
  private pendingCloseAckResolve: (() => void) | null = null;

  /** Latest-wins target for a pending restart. Overwritten by every
   *  restart() call so rapid scrubs coalesce to one follow-up run. */
  private pendingRestartTarget: {
    startTime: number;
    endTime: number;
    initialSeekTime: string | null;
  } | null = null;

  private activeRestartPromise: Promise<boolean> | null = null;

  /**
   * Restart playback on the existing WebSocket with a new task_id and
   * time range.
   *
   * Coalescing: if a restart is already in flight, update the pending
   * target and return the in-flight promise. Rapid scrubs run at most
   * 2 iterations (active + one coalesced catch-up) instead of N
   * chained restarts each paying a 500ms close-ack wait.
   */
  async restart(
    startTime: number,
    endTime: number,
    initialSeekTime: string | null = null,
  ): Promise<boolean> {
    // Synchronously gate frames before the async work below — see
    // seekDropActive's declaration for why.
    this.seekDropActive = true;
    this.pendingRestartTarget = { startTime, endTime, initialSeekTime };

    if (this.activeRestartPromise) {
      return this.activeRestartPromise;
    }

    this.activeRestartPromise = (async () => {
      try {
        let ok = true;
        while (this.pendingRestartTarget) {
          const target = this.pendingRestartTarget;
          this.pendingRestartTarget = null;
          const iterationOk = await this.runRestart(
            target.startTime,
            target.endTime,
            target.initialSeekTime,
          );
          if (!iterationOk) ok = false;
        }
        return ok;
      } finally {
        this.activeRestartPromise = null;
      }
    })();
    return this.activeRestartPromise;
  }

  private async runRestart(
    startTime: number,
    endTime: number,
    initialSeekTime: string | null,
  ): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.seekDropActive = false;
      return false;
    }

    // Rotate taskId BEFORE issuing the close. Frames arriving during the
    // close-ack wait carry the old task_id and are dropped by the filter
    // in handleBinaryMessage.
    const oldTaskId = this.taskId;
    this.taskId = generateTaskId();
    this.seekDropActive = false;

    this.pendingCloseAck = new Promise<void>((resolve) => {
      this.pendingCloseAckResolve = resolve;
    });
    this.sendPlaybackCloseCmd(oldTaskId);

    await Promise.race([
      this.pendingCloseAck,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    this.pendingCloseAck = null;
    this.pendingCloseAckResolve = null;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    this.frameCount = 0;
    this.lastSentIndex = 0;
    this.lastPts = 0;
    this.lastSeq = 0;
    this.nextAckWall = 0;
    this.receivedFirstFrame = false;
    this.resetGopObserver();
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
      this.ackScheduled = false;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.resetPacing();

    this.startTime = startTime;
    this.endTime = endTime;
    this.initialSeekTime = initialSeekTime;
    this.waitingForKeyframe = true;
    this.setLoading(true);
    if (this.keyframeWaitTimer) clearTimeout(this.keyframeWaitTimer);
    this.keyframeWaitTimer = setTimeout(() => {
      if (this.waitingForKeyframe) {
        console.log(
          `[playback ${this.channelId.slice(1, 9)}] keyframe wait timeout — releasing gate`,
        );
        this.waitingForKeyframe = false;
      }
      this.keyframeWaitTimer = null;
    }, PlaybackConnection.KEYFRAME_WAIT_TIMEOUT_MS);

    // Web client capture sends open + (key|all)_frame + audio/close
    // back-to-back without waiting for #response.
    this.sendPlaybackOpen();
    if (initialSeekTime) {
      if (this.speed > KEYFRAME_MODE_SPEED_THRESHOLD) {
        this.sendKeyFrame(initialSeekTime);
        this.isKeyFrameMode = true;
      } else {
        this.sendAllFrame(initialSeekTime);
        this.isKeyFrameMode = false;
      }
      this.initialSeekTime = null;
    }
    this.sendAudioClose();
    return true;
  }

  private sendPlaybackCloseCmd(taskId: string = this.taskId): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const closeCmd = {
        url: "/device/playback/close",
        basic: {
          ver: "1.0",
          id: 2,
          time: Date.now(),
          nonce: randomUint32(),
        },
        data: {
          task_id: taskId,
        },
      };
      this.ws.send(JSON.stringify(closeCmd));
    } catch {
      // best-effort
    }
  }

  close(): void {
    this.sendPlaybackCloseCmd();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    this.alive = false;
    this.sink = null;
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
      this.ackScheduled = false;
    }
    this.nextAckWall = 0;
    if (this.keyframeWaitTimer) {
      clearTimeout(this.keyframeWaitTimer);
      this.keyframeWaitTimer = null;
    }
    if (this.pendingSeekCheck) {
      clearTimeout(this.pendingSeekCheck.timer);
      this.pendingSeekCheck.resolve("timeout");
      this.pendingSeekCheck = null;
    }
    if (this.loadingWatchdog) {
      clearTimeout(this.loadingWatchdog);
      this.loadingWatchdog = null;
    }
    this.waitingForKeyframe = false;
    this.seekDropActive = false;
    this.resetPacing();
  }

  setSink(sink: FrameSink): void {
    this.sink = sink;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** Conservative rewind from leading-edge PTS to estimate the display
   *  position on a mode-upgrade restart. */
  private static readonly UPGRADE_REWIND_SECONDS = 12;

  /** Estimated DISPLAYED unix time (not the server's leading edge).
   *  Returns null before the first frame. */
  getEstimatedDisplayUnix(): number | null {
    if (!this.lastPts) return null;
    const frameUnix =
      this.lastPts / 10_000_000 - PlaybackConnection.FILETIME_UNIX_OFFSET_SEC;
    return frameUnix - PlaybackConnection.UPGRADE_REWIND_SECONDS;
  }

  /** Unix seconds of the most recently received frame. Used for
   *  detach-restore resync (continuity from departing view, no rewind). */
  getLastFrameUnix(): number | null {
    if (!this.lastPts) return null;
    return this.lastPts / 10_000_000 - PlaybackConnection.FILETIME_UNIX_OFFSET_SEC;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private handleTextMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (msg.url?.endsWith("create_connection#response")) {
        this.alive = true;
        this.sendPlaybackOpen();
      } else if (msg.url === "/device/playback/close#response") {
        this.pendingCloseAckResolve?.();
      } else if (msg.url === "/device/playback/open#response") {
        // Initial open path: send (key|all)_frame + audio/close here.
        // restart() sends them eagerly and clears initialSeekTime first.
        if (this.initialSeekTime) {
          if (this.speed > KEYFRAME_MODE_SPEED_THRESHOLD) {
            this.sendKeyFrame(this.initialSeekTime);
            this.isKeyFrameMode = true;
          } else {
            this.sendAllFrame(this.initialSeekTime);
            this.isKeyFrameMode = false;
          }
          this.initialSeekTime = null;
        }
        this.sendAudioClose();
      }
    } catch {
      // ignore non-JSON text frames
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    if (!this.sink) return;
    // Drop frames during a restart's microtask gap before taskId rotates.
    // See seekDropActive's declaration.
    if (this.seekDropActive) return;
    try {
      const chunk = new Uint8Array(data);
      const wsFrame = parseWSFrame(chunk);

      // Drop straggler frames from a previous task. The old task keeps
      // emitting briefly during a restart; counting their seq would push
      // lastSentIndex past the new task's seq range and silently drop
      // every new-task ACK (`lastSeq <= lastSentIndex` guard).
      const frameTaskId = (wsFrame.header.data as { task_id?: string })
        ?.task_id;
      if (frameTaskId && frameTaskId !== this.taskId) {
        return;
      }

      const shfl = parseSHFL(wsFrame.payload);

      // Accept frameType 0 (normal video) and 4 (the resync keyframe the
      // server emits as the first frame after a restart's playback/open).
      if (
        (shfl.frameType === 0 || shfl.frameType === 4) &&
        shfl.payload.byteLength > 0
      ) {
        // Always count + ACK frames so the server keeps streaming, even
        // when we're suppressing delivery to the decoder (keyframe gate).
        this.resetStallTimer();
        const pts =
          shfl.timestampLow + shfl.timestampHigh * 0x100000000;
        // Track GOP from PTS deltas between consecutive keyframes. Only
        // meaningful in keyframe-only mode (every frame is a keyframe).
        if (this.isKeyFrameMode && shfl.isKeyFrame && this.prevKeyframePts !== null) {
          const deltaSec = (pts - this.prevKeyframePts) / 10_000_000;
          if (deltaSec > 0.1 && deltaSec < 30) {
            this.recentGopSamples.push(deltaSec);
            if (this.recentGopSamples.length > PlaybackConnection.GOP_SAMPLE_SIZE) {
              this.recentGopSamples.shift();
            }
            if (this.recentGopSamples.length >= 3) {
              const sorted = [...this.recentGopSamples].sort((a, b) => a - b);
              this.observedGopSec = sorted[Math.floor(sorted.length / 2)];
            }
          }
        }
        // Track per-frame PTS delta for adaptive all-frame ACK pacing.
        // MIN of a sliding window — drops only inflate deltas. Filter
        // outliers (<20ms below plausible camera rate; >500ms is
        // keyframe-only or post-gap recovery).
        if (
          !this.isKeyFrameMode &&
          this.lastPts !== 0 &&
          pts > this.lastPts
        ) {
          const deltaMs = (pts - this.lastPts) / 10_000;
          if (deltaMs >= 20 && deltaMs <= 500) {
            this.recentFrameDeltas.push(deltaMs);
            if (
              this.recentFrameDeltas.length >
              PlaybackConnection.FRAME_DELTA_SAMPLE_SIZE
            ) {
              this.recentFrameDeltas.shift();
            }
            if (this.recentFrameDeltas.length >= 5) {
              let minDelta = this.recentFrameDeltas[0];
              for (let i = 1; i < this.recentFrameDeltas.length; i++) {
                if (this.recentFrameDeltas[i] < minDelta) {
                  minDelta = this.recentFrameDeltas[i];
                }
              }
              this.observedPtsPerFrameMs = minDelta;
            }
          }
        }

        if (shfl.isKeyFrame) this.prevKeyframePts = pts;
        this.lastPts = pts;
        this.lastSeq = shfl.seq;
        this.frameCount++;
        // Match the web client (wasm-player.js _onVideoFrame): in
        // all-frame mode only ACK on flow-control window multiples;
        // in keyframe-only mode ACK every frame.
        const shouldAck =
          shfl.seq > 0 &&
          (this.isKeyFrameMode || shfl.seq % FLOW_CONTROL_INTERVAL === 0);
        if (shouldAck) this.schedulePacedAck();

        // Keyframe gate: while waiting, ACK + count but don't deliver
        // (avoids broken reference chain → green tile).
        if (this.waitingForKeyframe) {
          if (!shfl.isKeyFrame) return;
          this.waitingForKeyframe = false;
          if (this.keyframeWaitTimer) {
            clearTimeout(this.keyframeWaitTimer);
            this.keyframeWaitTimer = null;
          }
        }

        // seekInPlace() verification: compare IDR's PTS against target.
        // Mismatch means the NVR ignored the all_frame; re-gate and
        // report so the manager can restart().
        if (this.pendingSeekCheck && shfl.isKeyFrame) {
          const frameUnix =
            pts / 10_000_000 - PlaybackConnection.FILETIME_UNIX_OFFSET_SEC;
          const check = this.pendingSeekCheck;
          const delta = Math.abs(frameUnix - check.expectedUnix);
          this.pendingSeekCheck = null;
          clearTimeout(check.timer);
          if (delta > check.toleranceSec) {
            this.waitingForKeyframe = true;
            check.resolve("mismatch");
            return;
          }
          check.resolve("ok");
        }

        if (!this.receivedFirstFrame) {
          this.receivedFirstFrame = true;
        }

        this.scheduleFrameDelivery(shfl.payload, shfl.isKeyFrame, pts);
      }
    } catch {
      // skip malformed frames
    }
  }

  /**
   * Schedule a paced ACK. No-op if one is already scheduled.
   *
   *   All-frame mode: targetGap = FRAMES_PER_ACK_ALL_FRAME × ptsPerFrame / speed.
   *   Keyframe mode:  targetGap = FRAMES_PER_ACK_KEYFRAME_MODE × GOP × 1000 / speed.
   *
   * In keyframe mode pacing IS the rate controller — the pacing-lead
   * pause in scheduleFrameDelivery is bypassed there.
   */
  private schedulePacedAck(): void {
    if (this.paused) return;
    if (this.ackScheduled) return;

    let targetGap: number;
    if (this.isKeyFrameMode) {
      const gopSec = this.observedGopSec ?? 2;
      targetGap =
        (PlaybackConnection.FRAMES_PER_ACK_KEYFRAME_MODE * gopSec * 1000) /
        this.speed;
    } else {
      // All-frame: match ACK cadence to server's delivery rate so the
      // 5s pacing-pause is a rare safety net.
      // rate × gap ≈ FRAMES_PER_ACK_ALL_FRAME × ptsPerFrame.
      const ptsPerFrameMs =
        this.observedPtsPerFrameMs ??
        PlaybackConnection.DEFAULT_PTS_PER_FRAME_MS;
      const rawGap =
        (PlaybackConnection.FRAMES_PER_ACK_ALL_FRAME * ptsPerFrameMs) /
        this.speed;
      targetGap = Math.min(
        PlaybackConnection.ACK_GAP_MAX_MS,
        Math.max(PlaybackConnection.ACK_GAP_MIN_MS, rawGap),
      );
    }
    const now = Date.now();
    // Absolute schedule: re-anchor only if no anchor or we've fallen so
    // far behind that catching up would burst. Otherwise a late fire
    // just shortens the next `delay`, keeping cadence locked to targetGap.
    if (this.nextAckWall === 0 || now - this.nextAckWall > targetGap) {
      this.nextAckWall = now + targetGap;
    }
    const delay = Math.max(0, this.nextAckWall - now);

    this.ackScheduled = true;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.ackScheduled = false;
      // Advance the grid by exactly targetGap, not actual elapsed.
      this.nextAckWall += targetGap;
      this.doSendAck();
    }, delay);
  }

  /**
   * Send refresh_play_index using the server-assigned frameIndex (matches
   * the web client). Required for 8× keyframe-only mode: keyframes carry
   * sparse global indices (e.g. 120, 240, 360) and the NVR only advances
   * on indices it recognises.
   */
  private doSendAck(): void {
    if (this.paused) return;
    if (this.lastSeq <= this.lastSentIndex) return;
    this.sendAckWithIndex(this.lastSeq);
  }

  private sendAckWithIndex(index: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastSentIndex = index;
    const cmd = {
      url: "/device/playback/refresh_play_index",
      basic: {
        ver: "1.0",
        id: 1,
        time: Date.now(),
        nonce: randomUint32(),
      },
      data: {
        task_id: this.taskId,
        play_frame_index: index,
      },
    };
    this.ws.send(JSON.stringify(cmd));
  }

  /**
   * Deliver to the decoder immediately. The H.264 reference chain must
   * stay intact (no JS-side holding/skipping). Display pacing is the
   * native CMTimebase's job; after gaps the Swift side re-anchors so
   * resumed frames aren't all "late".
   */
  private scheduleFrameDelivery(
    payload: Uint8Array,
    isKeyFrame: boolean,
    _pts: number,
  ): void {
    if (!this.sink) return;

    this.sink(payload, isKeyFrame, _pts);
    if (isKeyFrame) this.setLoading(false);

    if (PlaybackConnection.sharedSeekUnix === 0) return;
    if (this.frameCount < FLOW_CONTROL_INTERVAL * 2) return;
    // In keyframe mode, rate is controlled by ACK cadence. The PTS-lead
    // pause below is the wrong tool there — it would fire within <1s
    // wall at 8× and stall delivery.
    if (this.isKeyFrameMode) return;
    // User-paused connections still receive the server's initial ~32-frame
    // window before it notices. Running the pacing check could reset
    // sharedSeekUnix to a stale PTS and misalign every other connection.
    if (this.userPaused) return;

    const frameUnix =
      _pts / 10_000_000 - PlaybackConnection.FILETIME_UNIX_OFFSET_SEC;
    const wallElapsedSec =
      (Date.now() - PlaybackConnection.sharedSeekWall) / 1000;
    const expectedUnix =
      PlaybackConnection.sharedSeekUnix + wallElapsedSec * this.speed;
    const leadMs = (frameUnix - expectedUnix) * 1000;

    if (!this.pacedPaused && leadMs > PlaybackConnection.PACING_LEAD_MS) {
      // Flush any pending ACK BEFORE pausing. schedulePacedAck uses
      // setTimeout(0) but frames 1-16 process synchronously — without
      // this, lastSentIndex stays 0 and the resume ACK is wrong, leaving
      // the server with no valid flow-control signal (permanent stall).
      if (this.ackScheduled && this.ackTimer) {
        clearTimeout(this.ackTimer);
        this.ackTimer = null;
        this.ackScheduled = false;
        this.doSendAck();
      }
      this.pacedPaused = true;
      this.pause();
      const resumeDelay =
        (leadMs - PlaybackConnection.PACING_LEAD_MS / 2) / this.speed;
      if (this.pacingPauseTimer) clearTimeout(this.pacingPauseTimer);
      this.pacingPauseTimer = setTimeout(() => {
        this.pacingPauseTimer = null;
        // Don't auto-resume if the user has paused in the meantime — otherwise
        // the server keeps streaming into a paused timebase, building a
        // native queue that races on resume.
        if (this.pacedPaused && !this.userPaused) {
          this.pacedPaused = false;
          // Don't re-arm waitingForKeyframe — the reference chain is
          // intact and the server resumes from the same seq. Setting it
          // caused 5s of dropped P-frames after every resume (visible
          // stutter + loading-watchdog reopens). The Swift gap-detector
          // re-anchors the timebase, preventing the green-flash burst.
          this.resume();
        }
      }, Math.max(50, resumeDelay));
    }
  }

  /** Clear GOP-observer state. Called on restart() and seekInPlace() so
   *  the post-seek keyframe's delta from a stale prevKeyframePts doesn't
   *  pollute the running median. */
  private resetGopObserver(): void {
    this.observedGopSec = null;
    this.prevKeyframePts = null;
    this.recentGopSamples = [];
    // All-frame ACK pacing is per-camera (different fps cameras coexist).
    this.observedPtsPerFrameMs = null;
    this.recentFrameDeltas = [];
  }

  private resetPacing(): void {
    if (this.pacingPauseTimer) {
      clearTimeout(this.pacingPauseTimer);
      this.pacingPauseTimer = null;
    }
    this.pacedPaused = false;
    // Preserve user-pause intent across a task restart.
    this.paused = this.userPaused;
  }

  private resetStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    // When paused, "no frames for 15s" is expected. The server window's
    // in-flight tail still arrives after pause() clears the timer;
    // without this gate, those stragglers re-arm the watchdog and fire a
    // spurious reopen. resume() re-arms the watchdog explicitly.
    if (this.paused) return;
    this.stallTimer = setTimeout(() => {
      if (this.alive && this.receivedFirstFrame && !this.paused) {
        console.log(
          `[playback ${this.channelId.slice(1, 9)}] STALL DIAG — ` +
          `frameCount=${this.frameCount} lastSeq=${this.lastSeq} lastSentIndex=${this.lastSentIndex} ` +
          `paused=${this.paused} pacedPaused=${this.pacedPaused} ` +
          `waitingForKeyframe=${this.waitingForKeyframe} isKeyFrameMode=${this.isKeyFrameMode} ` +
          `speed=${this.speed} wsOpen=${this.ws?.readyState === WebSocket.OPEN} ` +
          `hasSink=${!!this.sink} taskId=${this.taskId.slice(1, 9)}`,
        );
        this.onStalled?.();
      }
    }, PlaybackConnection.STALL_TIMEOUT_MS);
  }

  /** User HQ preference (4K H.265 stream_index 0 vs transcoded 704×480
   *  H.264 stream_index 1). Set by the manager before open/restart; read
   *  at open time. Kept on the connection so the NVR module stays free
   *  of native-only Expo deps that break unit tests. */
  private hqMode = false;
  setHqMode(enabled: boolean): void {
    this.hqMode = enabled;
  }
  getHqMode(): boolean {
    return this.hqMode;
  }

  /**
   * Pick stream_index for /device/playback/open:
   *   0 — original (4K H.265). main mode, HQ on, 1× only. 4×+ can't
   *       sustain 4K keyframe delivery over WiFi; 2× is downgraded too.
   *   1 — transcoded (704×480 H.264). main mode otherwise.
   *   2 — sub stream. always for sub mode (grid tiles).
   */
  private resolveStreamIndex(): number {
    if (this.mode !== "main") return 2;
    const hqAllowed = this.speed <= MAX_HQ_SPEED;
    return this.hqMode && hqAllowed ? 0 : 1;
  }

  private sendPlaybackOpen(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cmd = {
      url: "/device/playback/open",
      basic: {
        ver: "1.0",
        id: 1,
        time: Date.now(),
        nonce: randomUint32(),
      },
      data: {
        task_id: this.taskId,
        channel_id: this.channelId,
        start_time: this.startTime,
        end_time: this.endTime,
        stream_index: this.resolveStreamIndex(),
        type_mask: TYPE_MASK,
      },
    };
    this.ws.send(JSON.stringify(cmd));
  }

  private sendAllFrame(frameTime: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cmd = {
      url: "/device/playback/all_frame",
      basic: {
        ver: "1.0",
        id: 1,
        time: Date.now(),
        nonce: randomUint32(),
      },
      data: {
        task_id: this.taskId,
        frame_time: frameTime,
      },
    };
    this.ws.send(JSON.stringify(cmd));
  }

  private sendKeyFrame(frameTime: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cmd = {
      url: "/device/playback/key_frame",
      basic: {
        ver: "1.0",
        id: 1,
        time: Date.now(),
        nonce: randomUint32(),
      },
      data: {
        task_id: this.taskId,
        frame_time: frameTime,
      },
    };
    this.ws.send(JSON.stringify(cmd));
  }

  private sendAudioClose(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cmd = {
      url: "/device/playback/audio/close",
      basic: {
        ver: "1.0",
        id: 1,
        time: Date.now(),
        nonce: randomUint32(),
      },
      data: {
        task_id: this.taskId,
      },
    };
    this.ws.send(JSON.stringify(cmd));
  }
}
