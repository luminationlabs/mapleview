import { generateTaskId } from "./guid";
import { parseSHFL } from "./shfl";
import type { CameraStatus, FrameSink, StreamMode } from "./types";
import { debugLog } from "../utils/debug-log";
import { parseWSFrame } from "./ws-frame";
import { wsUrl } from "../utils/parse-host";

export type StatusChangeCallback = (
  channelId: string,
  status: CameraStatus,
) => void;

function randomUint32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/**
 * Manages a single WebSocket stream connection to an NVR channel.
 *
 * Lifecycle:
 *   1. open() -> creates WS, waits for create_connection#response
 *   2. Sends preview/open command
 *   3. Binary frames arrive -> parseWSFrame -> parseSHFL -> sink
 *   4. close() -> sends preview/close, closes WS
 */
export class StreamConnection {
  readonly channelId: string;
  readonly mode: StreamMode;
  readonly hqMode: boolean;
  readonly taskId: string;

  private ws: WebSocket | null = null;
  private sink: FrameSink | null = null;
  private alive = false;
  private receivedFirstFrame = false;
  private failureReported = false;
  private stallReported = false;
  /** Set by close() so the WS handlers can distinguish user-initiated
   * close from a server-side drop — we don't want to schedule a retry for
   * a connection the caller explicitly told us to tear down. */
  private intentionalClose = false;
  private onStatusChange: StatusChangeCallback | null = null;

  /**
   * Called when the WebSocket connection itself fails (e.g. NVR returns
   * 400 on upgrade). Receives the WS close code if one is available —
   * used by the client to evict sessions that keep producing abnormal
   * closes (the HTTP 400 → code=1006 pattern seen when a session has
   * been invalidated server-side).
   */
  onConnectionFailed: ((closeCode?: number) => void) | null = null;

  /** Called when the stream stalls (no frames for STALL_TIMEOUT_MS). */
  onStalled: (() => void) | null = null;

  /** Watchdog: fires if no frames arrive within this window */
  private static readonly STALL_TIMEOUT_MS = 8000;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(channelId: string, mode: StreamMode, hqMode = true) {
    this.channelId = channelId;
    this.mode = mode;
    // For 'main' (single-cam live), HQ on = stream_index 1 (4K H.265),
    // HQ off = stream_index 2 (704×480 H.264 sub, same tier as the grid).
    // preview/open rejects stream_index 0, so 1/2 is the full set of
    // tiers available for live. 'sub' always uses 2.
    this.hqMode = hqMode;
    this.taskId = generateTaskId();
  }

  setOnStatusChange(cb: StatusChangeCallback | null): void {
    this.onStatusChange = cb;
  }

  open(host: string, sessionId: string, sink: FrameSink): void {
    this.sink = sink;
    this.receivedFirstFrame = false;
    this.failureReported = false;
    this.stallReported = false;
    this.intentionalClose = false;
    debugLog.info(
      `[stream] opening ch=${this.channelId} mode=${this.mode} session=${sessionId.slice(0, 8)}`,
    );
    const url = wsUrl(host, `/requestWebsocketConnection?sessionID=${sessionId}`);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    this.onStatusChange?.(this.channelId, "connecting");

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleTextMessage(event.data);
      } else {
        this.handleBinaryMessage(event.data as ArrayBuffer);
      }
    };

    ws.onerror = () => {
      this.alive = false;
      if (this.intentionalClose) return;
      if (!this.receivedFirstFrame) {
        debugLog.warn(
          `[stream] ws error pre-frame ch=${this.channelId} mode=${this.mode}`,
        );
        if (!this.failureReported) {
          this.failureReported = true;
          this.onConnectionFailed?.();
        }
      } else {
        debugLog.warn(
          `[stream] ws error post-frame ch=${this.channelId} mode=${this.mode}`,
        );
        // WS died mid-stream. Route through onStalled so the client's
        // existing retry path reopens — otherwise this would flip status
        // to "failed" and sit there until the 8s stall watchdog fires
        // (or forever, if the watchdog's alive/firstFrame guard short-
        // circuits after the WS tears down).
        this.fireStall();
      }
    };

    ws.onclose = (event: WebSocketCloseEvent) => {
      this.alive = false;
      if (this.intentionalClose) return;
      if (!this.receivedFirstFrame) {
        // Close before any frame — usually means the NVR rejected the WS
        // upgrade (the classic release-mode failure). Log code/reason so the
        // in-app overlay shows exactly why.
        debugLog.warn(
          `[stream] ws closed pre-frame ch=${this.channelId} mode=${this.mode} code=${event?.code ?? "?"} reason=${event?.reason ?? ""}`,
        );
        if (!this.failureReported) {
          this.failureReported = true;
          this.onConnectionFailed?.(event?.code);
        }
      } else {
        // Post-frame clean close: server dropped us mid-stream (task
        // invalidated, NVR rebooted, network blip). No callback fired
        // here previously — the stream just went dead until the 8s stall
        // watchdog caught it. Treat it as a stall so the client reopens
        // immediately.
        debugLog.warn(
          `[stream] ws closed post-frame ch=${this.channelId} mode=${this.mode} code=${event?.code ?? "?"}`,
        );
        this.fireStall();
      }
    };
  }

  /**
   * Fire the stall callback at most once per open() cycle, whether
   * triggered by the watchdog timer, a post-frame ws.onerror, or a
   * post-frame ws.onclose. All three surface the same recovery intent
   * (reopen the stream); the guard prevents double-retry.
   */
  private fireStall(): void {
    if (this.stallReported) return;
    this.stallReported = true;
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.onStalled?.();
  }

  close(): void {
    // Mark before calling ws.close() so the onclose/onerror handlers
    // (which fire synchronously or on the next tick) don't schedule a
    // retry for a connection the caller deliberately tore down.
    this.intentionalClose = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const closeCmd = {
          url: "/device/preview/close",
          basic: {
            ver: "1.0",
            id: 2,
            time: Date.now(),
            nonce: randomUint32(),
          },
          data: {
            task_id: this.taskId,
          },
        };
        this.ws.send(JSON.stringify(closeCmd));
      } catch {
        // best-effort
      }
      this.ws.close();
    }
    this.ws = null;
    this.alive = false;
    this.sink = null;
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  setSink(sink: FrameSink): void {
    this.sink = sink;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  private handleTextMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      if (
        msg.url?.endsWith("create_connection#response")
      ) {
        this.alive = true;
        this.sendPreviewOpen();
      } else if (
        msg.url === "/device/preview/open#response"
      ) {
        // Preview is open; send audio/close
        this.sendAudioClose();
      }
    } catch {
      // ignore non-JSON text frames
    }
  }

  private handleBinaryMessage(data: ArrayBuffer): void {
    if (!this.sink) return;
    try {
      const chunk = new Uint8Array(data);
      const wsFrame = parseWSFrame(chunk);
      const shfl = parseSHFL(wsFrame.payload);
      // frameType 0 = video
      if (shfl.frameType === 0 && shfl.payload.byteLength > 0) {
        if (!this.receivedFirstFrame) {
          this.receivedFirstFrame = true;
          debugLog.info(
            `[stream] first frame ch=${this.channelId} mode=${this.mode}`,
          );
          this.onStatusChange?.(this.channelId, "online");
        }
        // Reset stall watchdog on every video frame
        this.resetStallTimer();
        const pts =
          shfl.timestampLow + shfl.timestampHigh * 0x100000000;
        this.sink(shfl.payload, shfl.isKeyFrame, pts);
      }
    } catch {
      // skip malformed frames
    }
  }

  /** 8 seconds is generous — sub-streams typically send at 15fps
   *  (~67ms), so this tolerates brief network hiccups and keyframe
   *  delays without false positives. */
  private resetStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.alive && this.receivedFirstFrame) {
        console.log(`[stream ${this.channelId.slice(1,9)}] stalled — no frames for ${StreamConnection.STALL_TIMEOUT_MS}ms`);
        this.fireStall();
      }
    }, StreamConnection.STALL_TIMEOUT_MS);
  }

  private sendPreviewOpen(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cmd = {
      url: "/device/preview/open",
      basic: {
        ver: "1.0",
        id: 1,
        time: Date.now(),
        nonce: randomUint32(),
      },
      data: {
        task_id: this.taskId,
        channel_id: this.channelId,
        stream_index: this.mode === "main" ? (this.hqMode ? 1 : 2) : 2,
        audio: false,
      },
    };
    this.ws.send(JSON.stringify(cmd));
  }

  private sendAudioClose(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const cmd = {
      url: "/device/audio/close",
      basic: {
        ver: "1.0",
        id: 3,
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
