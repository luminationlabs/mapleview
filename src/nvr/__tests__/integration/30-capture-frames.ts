/**
 * Probe 30 — capture representative WS frames for the bench fixtures.
 *
 * Connects to a real NVR and grabs one of each frame variety the JS/Swift
 * parsing benchmarks need:
 *
 *   sub-pframe.bin            sub stream (index 2, 704×480 H.264) P-frame
 *   sub-keyframe.bin          sub stream IDR (with SPS+PPS)
 *   main-h264-pframe.bin      transcoded main (index 1, 704×480 H.264) P-frame
 *   main-h264-keyframe.bin    transcoded main IDR
 *   main-h265-keyframe.bin    HQ main (index 0, 4K H.265) IDR (with VPS+SPS+PPS)
 *
 * Each .bin is the raw WebSocket binary chunk (parseWSFrame-ready). A
 * sidecar fixtures.json records metadata so benches can sanity-check
 * what they loaded.
 *
 * The probe opens one WS at a time, captures the slots that stream can
 * fill, closes cleanly, then moves on. The initial flow-control window
 * (~8 frames) is enough to grab a keyframe + a P-frame without paced
 * ACKs, so this stays simple.
 *
 * Note: on this NVR the first frame of every fresh playback/open is
 * already `frameType=4` (the resync IDR for the requested seek time).
 * A separate "resync" fixture isn't needed — the JS parsing path
 * (parseWSFrame / parseSHFL / sink copy) doesn't branch on frameType.
 *
 * Run:
 *   npx tsx src/nvr/__tests__/integration/30-capture-frames.ts
 *
 * Output goes to bench/fixtures/ at the repo root (committed alongside
 * the benches so CI / other devs can run them without an NVR).
 */
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCredentials,
  login as probeLogin,
  listOnlineChannels,
  sleep,
  defaultPlaybackRange,
  type NvrSession,
} from "./harness";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL } from "../../shfl";

/** Known codec per stream_index per the protocol — more reliable than
 *  scanning the payload (`detectCodec` aliases certain H.264 P-slice NAL
 *  bytes as H.265 VPS, since 0x41 has h264Type=1 AND h265Type=32). */
function codecForStreamIndex(idx: 0 | 1 | 2): "h264" | "h265" {
  return idx === 0 ? "h265" : "h264";
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "bench", "fixtures");
const WATCHDOG_MS = 90_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const POST_LOGIN_SETTLE_MS = 500;
const FILETIME_UNIX_OFFSET_SEC = 11644473600;

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

function randomU32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

function unixToUtcTimeStr(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}:000`
  );
}

interface FixtureSlot {
  /** File name (without dir). */
  name: string;
  /** Predicate over the parsed SHFL frame. */
  match: (info: { isKeyFrame: boolean; frameType: number }) => boolean;
}

interface FixtureRecord {
  name: string;
  byteLength: number;
  isKeyFrame: boolean;
  frameType: number;
  codec: "h264" | "h265" | "unknown";
  /** PTS in unix seconds (for human inspection). */
  ptsUnix: number;
  streamIndex: number;
  channelId: string;
  capturedAt: string;
}

function classifyAndSave(
  chunk: Uint8Array,
  slot: FixtureSlot,
  streamIndex: 0 | 1 | 2,
  channelId: string,
): FixtureRecord {
  const ws = parseWSFrame(chunk);
  const shfl = parseSHFL(ws.payload);
  const codec = codecForStreamIndex(streamIndex);
  const ptsRaw = shfl.timestampLow + shfl.timestampHigh * 0x100000000;
  const ptsUnix = ptsRaw / 10_000_000 - FILETIME_UNIX_OFFSET_SEC;

  const path = join(FIXTURES_DIR, slot.name);
  writeFileSync(path, Buffer.from(chunk));

  return {
    name: slot.name,
    byteLength: chunk.byteLength,
    isKeyFrame: shfl.isKeyFrame,
    frameType: shfl.frameType,
    codec,
    ptsUnix,
    streamIndex,
    channelId,
    capturedAt: new Date().toISOString(),
  };
}

interface CaptureRunOptions {
  label: string;
  session: NvrSession;
  channelId: string;
  range: { start: number; end: number };
  streamIndex: 0 | 1 | 2;
  slots: FixtureSlot[];
}

interface CaptureRunResult {
  records: FixtureRecord[];
  failed: string[];
}

/**
 * Open one playback stream, collect raw WS chunks, save matching slots.
 * Returns when all desired slots are filled OR the timeout fires.
 */
async function captureOnce(
  opts: CaptureRunOptions,
): Promise<CaptureRunResult> {
  const { label, session, channelId, range, streamIndex, slots } = opts;
  const taskIdRef = { current: generateTaskId() };
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  const remaining = new Map<string, FixtureSlot>(slots.map((s) => [s.name, s]));
  const records: FixtureRecord[] = [];

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const watchdog = setTimeout(() => {
    console.error(
      `[${label}] timeout after ${FIRST_FRAME_TIMEOUT_MS}ms — remaining: ` +
        `${[...remaining.keys()].join(", ") || "(none)"}`,
    );
    resolveDone();
  }, FIRST_FRAME_TIMEOUT_MS);

  ws.on("unexpected-response", (_req, res) => {
    console.error(`[${label}] upgrade HTTP ${res.statusCode}`);
    try {
      res.resume();
    } catch {
      /* best-effort */
    }
    resolveDone();
  });

  ws.on("error", (err) => {
    console.error(`[${label}] ws error: ${err instanceof Error ? err.message : err}`);
  });

  ws.on("close", (code, reason) => {
    console.log(
      `[${label}] ws closed code=${code} reason=${reason?.toString() ?? ""}`,
    );
    resolveDone();
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = typeof data === "string" ? data : data.toString("utf-8");
      handleText(text);
      return;
    }
    let chunk: Uint8Array;
    if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (Buffer.isBuffer(data))
      chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (Array.isArray(data)) chunk = new Uint8Array(Buffer.concat(data));
    else return;

    try {
      const wsFrame = parseWSFrame(chunk);
      const frameTaskId = (wsFrame.header.data as { task_id?: string })?.task_id;
      if (frameTaskId && frameTaskId !== taskIdRef.current) return;

      const shfl = parseSHFL(wsFrame.payload);
      if (!(shfl.frameType === 0 || shfl.frameType === 4)) return;
      if (shfl.payload.byteLength === 0) return;

      const info = { isKeyFrame: shfl.isKeyFrame, frameType: shfl.frameType };

      for (const [name, slot] of remaining) {
        if (slot.match(info)) {
          const record = classifyAndSave(chunk, slot, streamIndex, channelId);
          records.push(record);
          remaining.delete(name);
          console.log(
            `[${label}] saved ${name} (${chunk.byteLength}B, ` +
              `kf=${info.isKeyFrame}, ft=${info.frameType}, codec=${record.codec})`,
          );
          break;
        }
      }

      if (remaining.size === 0) {
        resolveDone();
      }
    } catch (err) {
      // swallow — malformed frames shouldn't abort the probe
      if (process.env.PROBE_DEBUG) {
        console.error(
          `[${label}] parse error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  });

  function handleText(text: string): void {
    let msg: { url?: string; basic?: { code?: number; msg?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.url?.endsWith("create_connection#response")) {
      sendOpen();
      return;
    }
    if (msg.url === "/device/playback/open#response") {
      const code = msg.basic?.code;
      if (typeof code === "number" && code !== 0) {
        console.error(
          `[${label}] playback/open code=${code} msg=${msg.basic?.msg ?? ""}`,
        );
        resolveDone();
      }
      return;
    }
  }

  function sendOpen(): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        url: "/device/playback/open",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskIdRef.current,
          channel_id: channelId,
          start_time: range.start,
          end_time: range.end,
          stream_index: streamIndex,
          type_mask: TYPE_MASK,
        },
      }),
    );
    ws.send(
      JSON.stringify({
        url: "/device/playback/all_frame",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskIdRef.current,
          frame_time: unixToUtcTimeStr(range.start),
        },
      }),
    );
    ws.send(
      JSON.stringify({
        url: "/device/playback/audio/close",
        basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskIdRef.current },
      }),
    );
  }

  await done;
  clearTimeout(watchdog);

  // Clean close: tell the server we're done so it releases the slot.
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          url: "/device/playback/close",
          basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
          data: { task_id: taskIdRef.current },
        }),
      );
    }
    ws.close();
  } catch {
    /* best-effort */
  }
  await sleep(150);

  return {
    records,
    failed: [...remaining.keys()],
  };
}

async function main(): Promise<void> {
  const hardKill = setTimeout(() => {
    console.error(`\n[watchdog] ${WATCHDOG_MS}ms elapsed — exiting`);
    process.exit(2);
  }, WATCHDOG_MS).unref();

  mkdirSync(FIXTURES_DIR, { recursive: true });

  const creds = loadCredentials();
  const session = await probeLogin(creds);
  console.log(
    `login ok in ${session.loginMs}ms (sessionId=${session.sessionId.slice(0, 8)})`,
  );
  await sleep(POST_LOGIN_SETTLE_MS);

  const channelId = await (async () => {
    const env = process.env.PROBE_CHANNEL_ID;
    if (env && env.length > 0) return env;
    if (creds.channelId && creds.channelId.length > 0) return creds.channelId;
    const online = await listOnlineChannels(session);
    if (online.length === 0) throw new Error("no online channels");
    return online[0];
  })();
  const range = defaultPlaybackRange(creds);
  console.log(
    `channel=${channelId.slice(1, 9)} range=${range.start}..${range.end}`,
  );

  const allRecords: FixtureRecord[] = [];
  const allFailed: string[] = [];

  // Pass 1 — sub stream. Two slots: keyframe (first frame of a fresh open
  // is always a keyframe) and the next P-frame after it.
  const subResult = await captureOnce({
    label: "sub",
    session,
    channelId,
    range,
    streamIndex: 2,
    slots: [
      { name: "sub-keyframe.bin", match: (i) => i.isKeyFrame },
      { name: "sub-pframe.bin", match: (i) => !i.isKeyFrame },
    ],
  });
  allRecords.push(...subResult.records);
  allFailed.push(...subResult.failed);

  // Pass 2 — main transcoded H.264 (stream_index=1). Same shape as sub
  // (one IDR + one P-frame). On this NVR these often byte-match the sub
  // fixtures since stream_index 1/2 emit the same encoded bitstream;
  // separate names are kept so other NVRs that produce distinct
  // bitstreams populate the bench properly.
  const mainH264Result = await captureOnce({
    label: "main-h264",
    session,
    channelId,
    range,
    streamIndex: 1,
    slots: [
      { name: "main-h264-keyframe.bin", match: (i) => i.isKeyFrame },
      { name: "main-h264-pframe.bin", match: (i) => !i.isKeyFrame },
    ],
  });
  allRecords.push(...mainH264Result.records);
  allFailed.push(...mainH264Result.failed);

  // Pass 3 — HQ 4K HEVC (stream_index=0). Only the keyframe is needed —
  // it exercises the H.265 VPS/SPS/PPS extraction path and is the largest
  // payload in the fixture set.
  const mainH265Result = await captureOnce({
    label: "main-h265",
    session,
    channelId,
    range,
    streamIndex: 0,
    slots: [{ name: "main-h265-keyframe.bin", match: (i) => i.isKeyFrame }],
  });
  allRecords.push(...mainH265Result.records);
  allFailed.push(...mainH265Result.failed);

  // Write the metadata sidecar.
  const summary = {
    capturedAt: new Date().toISOString(),
    host: session.host,
    channelId,
    range,
    fixtures: allRecords,
    failed: allFailed,
  };
  writeFileSync(
    join(FIXTURES_DIR, "fixtures.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log(`\n=== summary ===`);
  console.log(`captured ${allRecords.length} fixtures to ${FIXTURES_DIR}`);
  for (const r of allRecords) {
    console.log(
      `  ${r.name}  ${String(r.byteLength).padStart(7)}B  ` +
        `kf=${r.isKeyFrame} ft=${r.frameType} codec=${r.codec}`,
    );
  }
  if (allFailed.length > 0) {
    console.log(`failed slots: ${allFailed.join(", ")}`);
    process.exit(1);
  }

  clearTimeout(hardKill);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
