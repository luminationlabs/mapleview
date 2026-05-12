/**
 * Integration harness for probing real NVR behavior (session cap, login
 * invalidation, stagger thresholds, etc.) from Node. NOT run by Vitest — these
 * files don't end in `.test.ts` so `npm test` ignores them.
 *
 * Kept deliberately slim and Node-native (global fetch, `ws` package) so it
 * doesn't pull in RN-only helpers (XMLHttpRequest, login.ts' fetch-Cookie
 * workaround). Reuses only pure-JS helpers from the app: SHFL parsing, WS
 * frame parsing, password hash, task id.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest, type IncomingMessage } from "node:http";
import WebSocket from "ws";
import { XMLParser } from "fast-xml-parser";

import { computePasswordHash } from "../../crypto";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL } from "../../shfl";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");

export interface Credentials {
  host: string;
  username: string;
  password: string;
  /** Optional — if empty, harness will auto-pick the first online channel. */
  channelId?: string;
  /** Optional — unix seconds for playback probes. If 0, harness picks "now - 15 min" .. "now". */
  playbackStart?: number;
  playbackEnd?: number;
}

export function loadCredentials(): Credentials {
  const path = join(HERE, "credentials.json");
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Copy credentials.example.json and fill it in.`,
    );
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Credentials;
  if (!parsed.host || !parsed.username || !parsed.password) {
    throw new Error(`credentials.json is missing host/username/password`);
  }
  return parsed;
}

export interface NvrSession {
  host: string;
  sessionId: string; // bare UUID
  token: string;
  userName: string;
  /** Wall-clock ms when login completed. */
  loggedInAt: number;
  /** Login duration in ms (reqLogin + doLogin combined). */
  loginMs: number;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  trimValues: true,
  parseTagValue: true,
  isArray: (_name, jpath) => {
    if (typeof jpath !== "string") return false;
    return [
      "response.content.list.item",
      "response.content.item",
      "response.content.chlList.chl",
    ].some((p) => jpath.endsWith(p));
  },
});

function stripBraces(s: string): string {
  return s.startsWith("{") && s.endsWith("}") ? s.slice(1, -1) : s;
}

function buildRequestXml(token: string, content?: string): string {
  const block = content ? `<content>${content}</content>` : "";
  return (
    `<?xml version="1.0" encoding="utf-8" ?>` +
    `<request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
    `<token>${token}</token>${block}</request>`
  );
}

/**
 * Raw HTTP POST using node:http — NOT undici-backed fetch. Node 24's undici
 * negotiates keep-alive in a way this NVR rejects (socket closes after the
 * request is written, 0 bytes back). curl works fine, so we mirror its
 * behavior: one-shot request with Connection: close.
 */
function rawHttpPost(
  host: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host,
        port: 80,
        path,
        method: "POST",
        headers: {
          "User-Agent": "lumaplayback-integration/1.0",
          Accept: "*/*",
          Connection: "close",
          "Content-Length": Buffer.byteLength(body, "utf-8"),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Node-native NVR login (no XMLHttpRequest). Uses global fetch which, unlike
 * React Native's fetch on iOS, does not strip manually-set Cookie headers.
 */
export async function login(creds: Credentials): Promise<NvrSession> {
  const started = Date.now();
  const { host, username, password } = creds;

  // Step 1: /reqLogin
  const reqLoginBody = buildRequestXml("null");
  const reqLoginResp = await rawHttpPost(host, "/reqLogin", {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: `http://${host}/`,
  }, reqLoginBody);
  if (reqLoginResp.status < 200 || reqLoginResp.status >= 300) {
    throw new Error(`reqLogin HTTP ${reqLoginResp.status}`);
  }
  const reqLoginXml = reqLoginResp.body;
  const reqLoginParsed = xmlParser.parse(reqLoginXml) as {
    response?: { status?: string; content?: Record<string, unknown> };
  };
  const reqContent = reqLoginParsed.response?.content ?? {};
  if (reqLoginParsed.response?.status !== "success") {
    throw new Error(`reqLogin status=${reqLoginParsed.response?.status}`);
  }
  const sessionIdBraced = String(reqContent.sessionId ?? "");
  const nonce = String(reqContent.nonce ?? "");
  const token = String(reqContent.token ?? "");
  if (!sessionIdBraced || !nonce || !token) {
    throw new Error(`reqLogin missing sessionId/nonce/token`);
  }
  const sessionId = stripBraces(sessionIdBraced);

  // Step 2: /doLogin
  const passwordHash = computePasswordHash(password, nonce);
  const content =
    `<userName><![CDATA[${username}]]></userName>` +
    `<password><![CDATA[${passwordHash}]]></password>`;
  const doLoginBody = buildRequestXml(token, content);
  const doLoginResp = await rawHttpPost(host, "/doLogin", {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: `http://${host}/`,
    Cookie: `sessionId=${sessionId}`,
  }, doLoginBody);
  if (doLoginResp.status < 200 || doLoginResp.status >= 300) {
    throw new Error(`doLogin HTTP ${doLoginResp.status}`);
  }
  const doLoginXml = doLoginResp.body;
  const doLoginParsed = xmlParser.parse(doLoginXml) as {
    response?: { status?: string; content?: Record<string, unknown> };
  };
  if (doLoginParsed.response?.status !== "success") {
    const msg =
      (doLoginParsed.response?.content as { errorDescription?: string } | undefined)
        ?.errorDescription ?? "";
    throw new Error(`doLogin status=${doLoginParsed.response?.status} ${msg}`);
  }

  const loggedInAt = Date.now();
  return {
    host,
    sessionId,
    token,
    userName: username,
    loggedInAt,
    loginMs: loggedInAt - started,
  };
}

/**
 * List online channel IDs via /queryOnlineChlList.
 */
export async function listOnlineChannels(
  session: NvrSession,
): Promise<string[]> {
  const body = buildRequestXml(session.token);
  const resp = await rawHttpPost(session.host, "/queryOnlineChlList", {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: `http://${session.host}/`,
    Cookie: `sessionId=${session.sessionId}`,
  }, body);
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`queryOnlineChlList HTTP ${resp.status}`);
  }
  const parsed = xmlParser.parse(resp.body) as {
    response?: { content?: { item?: unknown[] } };
  };
  const items = parsed.response?.content?.item;
  if (!items) return [];
  const arr = Array.isArray(items) ? items : [items];
  return arr.map((it) => String((it as { "@_id"?: unknown })["@_id"] ?? ""));
}

export async function pickChannelId(
  session: NvrSession,
  creds: Credentials,
): Promise<string> {
  if (creds.channelId && creds.channelId.length > 0) return creds.channelId;
  const onlines = await listOnlineChannels(session);
  if (onlines.length === 0) {
    throw new Error(`No online channels found on NVR`);
  }
  return onlines[0];
}

export type OpenKind = "preview" | "playback";

export interface OpenOptions {
  kind: OpenKind;
  channelId: string;
  mode: "main" | "sub";
  /** Required for playback; ignored for preview. */
  playbackRange?: { start: number; end: number };
  /** Human label for logs. */
  label: string;
  /**
   * Wait up to this long for the first video SHFL frame. If 0, don't wait
   * (useful for probes that only care about upgrade success).
   */
  firstFrameTimeoutMs?: number;
}

export interface OpenAttempt {
  label: string;
  kind: OpenKind;
  channelId: string;
  mode: "main" | "sub";
  sessionId: string;
  startedAtMs: number;
  /** Did the HTTP Upgrade → 101 succeed? */
  upgradeSuccess: boolean;
  /** HTTP status if the server rejected the upgrade (e.g. 400). */
  upgradeHttpStatus?: number;
  upgradeMs?: number;
  /** WebSocket close code from `ws` close event (1006 for abnormal). */
  closeCode?: number;
  closeReason?: string;
  /** Time between upgrade and first create_connection#response text frame. */
  createConnectionMs?: number;
  /** Time from upgrade to first video SHFL frame. */
  firstFrameMs?: number;
  /** If playback/preview/open came back with a non-zero `code`, record it. */
  openResponseCode?: number;
  openResponseMsg?: string;
  firstFrameError?: string;
}

export interface OpenHandle {
  attempt: OpenAttempt;
  ws: WebSocket | null;
  taskId: string;
  close: () => Promise<void>;
  /**
   * Resolves when: (a) firstFrame received, (b) firstFrameTimeoutMs elapsed,
   * or (c) WS closed/errored. After it resolves, `attempt` is fully populated.
   */
  done: Promise<void>;
}

/**
 * Open a preview or playback stream and collect timing/outcome data.
 *
 * The handle is returned immediately (synchronously-ish) with `done` resolving
 * once the probe-relevant event has happened. Callers MUST call `close()` when
 * finished so probes don't leak WSes / session slots.
 */
export function openStream(
  session: NvrSession,
  opts: OpenOptions,
): OpenHandle {
  const taskId = generateTaskId();
  const startedAtMs = Date.now();
  const attempt: OpenAttempt = {
    label: opts.label,
    kind: opts.kind,
    channelId: opts.channelId,
    mode: opts.mode,
    sessionId: session.sessionId,
    startedAtMs,
    upgradeSuccess: false,
  };

  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let upgradeTime: number | null = null;
  let createConnTime: number | null = null;
  let receivedFirstFrame = false;
  let resolved = false;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const markDone = () => {
    if (resolved) return;
    resolved = true;
    resolveDone();
  };

  const timeout = opts.firstFrameTimeoutMs ?? 8000;
  const firstFrameTimer =
    timeout > 0
      ? setTimeout(() => {
          if (!receivedFirstFrame) {
            attempt.firstFrameError = attempt.firstFrameError ?? "timeout";
            markDone();
          }
        }, timeout)
      : null;

  ws.on("upgrade", () => {
    upgradeTime = Date.now();
    attempt.upgradeSuccess = true;
    attempt.upgradeMs = upgradeTime - startedAtMs;
  });

  ws.on("unexpected-response", (_req, res) => {
    attempt.upgradeHttpStatus = res.statusCode;
    attempt.firstFrameError = `upgrade HTTP ${res.statusCode}`;
    // The ws lib won't emit 'open' after this; also not always 'close'. Force
    // the done-resolution here so probes don't hang.
    markDone();
    try {
      res.resume();
    } catch {
      // best-effort
    }
  });

  ws.on("open", () => {
    // Upgrade succeeded. Do NOT send preview/playback open here — the NVR
    // sends /device/create_connection#response proactively right after
    // Upgrade, and we mirror the app by waiting for that ack before issuing
    // our open command. Sending early occasionally results in the NVR
    // dropping the open command silently.
  });

  ws.on("message", (data, isBinary) => {
    try {
      if (!isBinary) {
        const text = data.toString("utf-8");
        if (process.env.PROBE_DEBUG) {
          console.error(`[${opts.label}] TEXT: ${text.slice(0, 300)}`);
        }
        handleText(text);
        return;
      }
      // With ws.binaryType = "arraybuffer", data is an ArrayBuffer. Without
      // that, it's a Buffer (or Buffer[] for fragmented frames). Handle both
      // so debug output and decoding are correct either way.
      let chunk: Uint8Array;
      if (data instanceof ArrayBuffer) {
        chunk = new Uint8Array(data);
      } else if (Buffer.isBuffer(data)) {
        chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else if (Array.isArray(data)) {
        chunk = new Uint8Array(Buffer.concat(data));
      } else {
        return;
      }
      if (process.env.PROBE_DEBUG && !receivedFirstFrame) {
        console.error(`[${opts.label}] BIN: ${chunk.byteLength} bytes`);
      }
      if (receivedFirstFrame) return;
      const wsFrame = parseWSFrame(chunk);
      const shfl = parseSHFL(wsFrame.payload);
      // Match what the app accepts: frameType 0 (normal) or 4 (post-restart
      // resync keyframe). Either is a "stream is live" signal.
      if (
        (shfl.frameType === 0 || shfl.frameType === 4) &&
        shfl.payload.byteLength > 0
      ) {
        receivedFirstFrame = true;
        attempt.firstFrameMs = Date.now() - startedAtMs;
        if (firstFrameTimer) clearTimeout(firstFrameTimer);
        markDone();
      }
    } catch {
      // swallow — malformed frame shouldn't abort the probe
    }
  });

  function handleText(text: string): void {
    let msg: {
      url?: string;
      basic?: { code?: number; msg?: string };
      data?: unknown;
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.url?.endsWith("create_connection#response")) {
      createConnTime = Date.now();
      if (upgradeTime !== null) {
        attempt.createConnectionMs = createConnTime - upgradeTime;
      }
      // In React Native the app sends preview/playback open AFTER this. Mirror
      // that — the NVR doesn't always route opens that fire before this ack.
      sendOpenCmd(ws, opts, taskId);
      return;
    }
    if (msg.url === "/device/preview/open#response" || msg.url === "/device/playback/open#response") {
      const code = msg.basic?.code;
      if (typeof code === "number" && code !== 0) {
        attempt.openResponseCode = code;
        attempt.openResponseMsg = msg.basic?.msg;
        attempt.firstFrameError = `open code=${code} msg=${msg.basic?.msg ?? ""}`;
        markDone();
        return;
      }
      // Mirror the app: after the server acks open, send audio/close. Without
      // this, the NVR does not begin emitting video frames for preview (and
      // for playback the behavior varies). The web client does the same
      // back-to-back, confirmed in captures.
      sendAudioClose(ws, opts, taskId);
    }
  }

  ws.on("close", (code, reason) => {
    attempt.closeCode = code;
    attempt.closeReason = reason.toString();
    if (!receivedFirstFrame) {
      if (!attempt.firstFrameError) {
        attempt.firstFrameError = `closed code=${code}`;
      }
      markDone();
    }
  });

  ws.on("error", () => {
    // Errors are typically reported via 'unexpected-response' (HTTP status) or
    // 'close' (code 1006). Leave handling there to avoid double-counting.
  });

  const close = async (): Promise<void> => {
    if (firstFrameTimer) clearTimeout(firstFrameTimer);
    if (ws.readyState === WebSocket.OPEN) {
      try {
        const closeCmd = {
          url:
            opts.kind === "preview"
              ? "/device/preview/close"
              : "/device/playback/close",
          basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
          data: { task_id: taskId },
        };
        ws.send(JSON.stringify(closeCmd));
      } catch {
        // best-effort
      }
    }
    try {
      ws.close();
    } catch {
      // best-effort
    }
  };

  return {
    attempt,
    ws,
    taskId,
    close,
    done,
  };
}

function sendOpenCmd(ws: WebSocket, opts: OpenOptions, taskId: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const stream_index = opts.mode === "main" ? 1 : 2;
  if (opts.kind === "preview") {
    const cmd = {
      url: "/device/preview/open",
      basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
      data: {
        task_id: taskId,
        channel_id: opts.channelId,
        stream_index,
        audio: false,
      },
    };
    if (process.env.PROBE_DEBUG) {
      console.error(`[${opts.label}] SEND: ${JSON.stringify(cmd).slice(0, 200)}`);
    }
    ws.send(JSON.stringify(cmd));
  } else {
    const range = opts.playbackRange;
    if (!range) {
      throw new Error("playback open missing playbackRange");
    }
    ws.send(
      JSON.stringify({
        url: "/device/playback/open",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskId,
          channel_id: opts.channelId,
          start_time: range.start,
          end_time: range.end,
          stream_index,
          type_mask: [
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
          ],
        },
      }),
    );
  }
}

function randomU32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

function sendAudioClose(ws: WebSocket, opts: OpenOptions, taskId: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Preview and playback use different audio-close URLs — matches the app.
  const url =
    opts.kind === "preview"
      ? "/device/audio/close"
      : "/device/playback/audio/close";
  ws.send(
    JSON.stringify({
      url,
      basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
      data: { task_id: taskId },
    }),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Write a probe's results to `results/<name>-<iso>.json` and print a copy to
 * stdout so the user doesn't have to open the file.
 */
export function writeResult(
  name: string,
  data: unknown,
): string {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(RESULTS_DIR, `${name}-${iso}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`\n=== ${name} results ===`);
  console.log(JSON.stringify(data, null, 2));
  console.log(`\nSaved to ${path}`);
  return path;
}

/**
 * Default playback range used by probes that don't care which window: the 15
 * minutes ending 30 minutes ago (old enough to be in the recording archive).
 */
export function defaultPlaybackRange(creds: Credentials): {
  start: number;
  end: number;
} {
  if (creds.playbackStart && creds.playbackEnd) {
    return { start: creds.playbackStart, end: creds.playbackEnd };
  }
  const now = Math.floor(Date.now() / 1000);
  return { start: now - 30 * 60, end: now - 15 * 60 };
}

/**
 * Force-kill a probe after `ms`. Use this in main() so a stuck probe doesn't
 * hang indefinitely if an unhandled promise path forgets to resolve.
 */
export function watchdog(ms: number): NodeJS.Timeout {
  return setTimeout(() => {
    console.error(`\n[watchdog] ${ms}ms elapsed — exiting forcibly`);
    process.exit(2);
  }, ms).unref();
}
