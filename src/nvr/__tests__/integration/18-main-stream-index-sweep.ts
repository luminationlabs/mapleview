/**
 * Probe 18 — sweep `stream_index` on /device/playback/open to find the
 * original (un-transcoded) main stream.
 *
 * Probe 17 showed that stream_index=1 yields 704x480 H.264 on channels
 * that queryChlRecLog says record at 3840x2160 main stream. The web
 * client's CMD_PLAYBACK_OPEN defaults to `stream_index: a.streamType||0`
 * (seen in captures/loginAndPlay.chlsj tx 104). One call site even had
 * `streamType: 1, // 0` — hinting that 0 was the original value before it
 * was bumped to 1 to feed the wasm decoder.
 *
 * Hypothesis: stream_index 0 = original recording (whatever the camera
 * sent — H.265 4K for most of our cameras), 1 = transcoded-for-wasm
 * (H.264 704x480), 2 = sub. AVSampleBufferDisplayLayer decodes both
 * H.264 and H.265 natively, so using 0 on native would avoid the
 * transcode.
 *
 * What the probe does: for one channel (the first online, or creds.channelId
 * if set), opens a fresh WS + playback for each stream_index in {0, 1, 2, 3},
 * waits for first keyframe, parses SPS → width×height, reports per index.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import WebSocket from "ws";

import {
  loadCredentials,
  login,
  pickChannelId,
  sleep,
  writeResult,
  watchdog,
  defaultPlaybackRange,
  type NvrSession,
} from "./harness";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL, detectCodec } from "../../shfl";

const WATCHDOG_MS = 60_000;
const FIRST_KEYFRAME_TIMEOUT_MS = 15_000;

const FILETIME_UNIX_OFFSET_SEC = 11644473600;

function unixToUtcTimeStr(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}:000`
  );
}

function randomU32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

// --- HTTP helpers (queryChlRecLog so we know what's supposed to be recorded) ---

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

async function queryRecordedStreamInfo(
  session: NvrSession,
  channelId: string,
  range: { start: number; end: number },
): Promise<{ mainResolution?: string; subResolution?: string; raw: string }> {
  // queryChlRecLog returns <item><chl>..<streamType>main|sub</streamType><resolution>3840x2160</resolution>...
  const startUtc = unixToUtcTimeStr(range.start);
  const endUtc = unixToUtcTimeStr(range.end);
  const body =
    `<?xml version="1.0" encoding="utf-8" ?>` +
    `<request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
    `<token>${session.token}</token>` +
    `<condition>` +
    `<chlIds type="list"><item id="${channelId}"></item></chlIds>` +
    `<startTime>${startUtc}</startTime><endTime>${endUtc}</endTime>` +
    `<recTypes type="list"><item>SCHEDULE</item><item>MANUAL</item><item>MOTION</item><item>SENSOR</item><item>INTELLIGENT</item><item>POS</item></recTypes>` +
    `</condition>` +
    `<types><recType type="enum"><enum>MOTION</enum><enum>SCHEDULE</enum><enum>SENSOR</enum><enum>MANUAL</enum><enum>INTELLIGENT</enum><enum>POS</enum><enum>NORMALALL</enum><enum>FACEDETECTION</enum><enum>FACEMATCH</enum><enum>VEHICLE</enum><enum>TRIPWIRE</enum><enum>INVADE</enum><enum>AOIENTRY</enum><enum>AOILEAVE</enum><enum>ITEMCARE</enum><enum>CROWDDENSITY</enum><enum>EXCEPTION</enum></recType></types>` +
    `</request>`;
  const resp = await rawHttpPost(session.host, "/queryChlRecLog", {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: `http://${session.host}/`,
    Cookie: `sessionId=${session.sessionId}`,
  }, body);
  const xml = resp.body;
  const result: { mainResolution?: string; subResolution?: string; raw: string } = { raw: xml };
  // Match a block containing <streamType>main</streamType> ... <resolution>XxY</resolution>
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const item of items) {
    const st = item.match(/<streamType>([^<]+)<\/streamType>/);
    const rs = item.match(/<resolution>([^<]+)<\/resolution>/);
    if (!st || !rs) continue;
    if (st[1] === "main" && !result.mainResolution) result.mainResolution = rs[1];
    if (st[1] === "sub" && !result.subResolution) result.subResolution = rs[1];
  }
  return result;
}

// --- SPS parsing (same as probe 17) ---

function rbspFromNal(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.byteLength; i++) {
    if (
      i + 2 < nal.byteLength &&
      nal[i] === 0x00 &&
      nal[i + 1] === 0x00 &&
      nal[i + 2] === 0x03
    ) {
      out.push(0x00, 0x00);
      i += 2;
    } else {
      out.push(nal[i]);
    }
  }
  return new Uint8Array(out);
}

class BitReader {
  private byteOffset = 0;
  private bitOffset = 0;
  constructor(private readonly buf: Uint8Array) {}
  readBit(): number {
    if (this.byteOffset >= this.buf.byteLength) throw new Error("BitReader: end");
    const bit = (this.buf[this.byteOffset] >> (7 - this.bitOffset)) & 1;
    this.bitOffset++;
    if (this.bitOffset === 8) { this.bitOffset = 0; this.byteOffset++; }
    return bit;
  }
  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v >>> 0;
  }
  readUE(): number {
    let zeros = 0;
    while (this.readBit() === 0 && zeros < 32) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }
  readSE(): number {
    const ue = this.readUE();
    return ue % 2 === 0 ? -(ue / 2) : (ue + 1) / 2;
  }
}

function parseH264Sps(sps: Uint8Array): { width: number; height: number } {
  const rbsp = rbspFromNal(sps);
  const br = new BitReader(rbsp.subarray(1));
  const profile_idc = br.readBits(8);
  br.readBits(8);
  br.readBits(8);
  br.readUE();
  let chroma_format_idc = 1;
  const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
  if (highProfiles.has(profile_idc)) {
    chroma_format_idc = br.readUE();
    if (chroma_format_idc === 3) br.readBit();
    br.readUE();
    br.readUE();
    br.readBit();
    if (br.readBit()) {
      const n = chroma_format_idc !== 3 ? 8 : 12;
      for (let i = 0; i < n; i++) {
        if (!br.readBit()) continue;
        const listSize = i < 6 ? 16 : 64;
        let lastScale = 8, nextScale = 8;
        for (let j = 0; j < listSize; j++) {
          if (nextScale !== 0) {
            const delta = br.readSE();
            nextScale = (lastScale + delta + 256) % 256;
          }
          if (nextScale !== 0) lastScale = nextScale;
        }
      }
    }
  }
  br.readUE();
  const pic_order_cnt_type = br.readUE();
  if (pic_order_cnt_type === 0) br.readUE();
  else if (pic_order_cnt_type === 1) {
    br.readBit(); br.readSE(); br.readSE();
    const n = br.readUE();
    for (let i = 0; i < n; i++) br.readSE();
  }
  br.readUE();
  br.readBit();
  const picW = br.readUE();
  const picH = br.readUE();
  const frameMbsOnly = br.readBit();
  if (!frameMbsOnly) br.readBit();
  br.readBit();
  const cropFlag = br.readBit();
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (cropFlag) {
    cl = br.readUE(); cr = br.readUE(); ct = br.readUE(); cb = br.readUE();
  }
  const subW = chroma_format_idc === 1 || chroma_format_idc === 2 ? 2 : 1;
  const subH = chroma_format_idc === 1 ? 2 : 1;
  const width = (picW + 1) * 16 - subW * (cl + cr);
  const height = (2 - frameMbsOnly) * (picH + 1) * 16 - subH * (2 - frameMbsOnly) * (ct + cb);
  return { width, height };
}

function parseH265Sps(sps: Uint8Array): { width: number; height: number } {
  const rbsp = rbspFromNal(sps);
  const br = new BitReader(rbsp.subarray(2));
  br.readBits(4);
  const maxSubLayers = br.readBits(3);
  br.readBit();
  br.readBits(2 + 1 + 5);
  br.readBits(32);
  br.readBits(4);
  br.readBits(43);
  br.readBits(1);
  br.readBits(8);
  const profPres: number[] = [];
  const levPres: number[] = [];
  for (let i = 0; i < maxSubLayers; i++) {
    profPres.push(br.readBit());
    levPres.push(br.readBit());
  }
  if (maxSubLayers > 0) {
    for (let i = maxSubLayers; i < 8; i++) br.readBits(2);
  }
  for (let i = 0; i < maxSubLayers; i++) {
    if (profPres[i]) { br.readBits(2 + 1 + 5); br.readBits(32); br.readBits(4); br.readBits(43); br.readBits(1); }
    if (levPres[i]) br.readBits(8);
  }
  br.readUE();
  const chroma = br.readUE();
  if (chroma === 3) br.readBit();
  const w = br.readUE();
  const h = br.readUE();
  const confFlag = br.readBit();
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (confFlag) { cl = br.readUE(); cr = br.readUE(); ct = br.readUE(); cb = br.readUE(); }
  const subW = chroma === 1 || chroma === 2 ? 2 : 1;
  const subH = chroma === 1 ? 2 : 1;
  return { width: w - subW * (cl + cr), height: h - subH * (ct + cb) };
}

function findSps(stream: Uint8Array): { codec: "h264" | "h265" | "unknown"; sps?: Uint8Array } {
  let codec: "h264" | "h265" | "unknown" = "unknown";
  const starts: number[] = [];
  for (let i = 0; i <= stream.byteLength - 4; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 0 && stream[i + 3] === 1) {
      starts.push(i);
    }
  }
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k] + 4;
    const e = k + 1 < starts.length ? starts[k + 1] : stream.byteLength;
    const nal = stream.subarray(s, e);
    if (nal.byteLength === 0) continue;
    const info = detectCodec(stream.subarray(starts[k]));
    if (codec === "unknown" && info.codec !== "unknown") codec = info.codec;
    const h264Type = nal[0] & 0x1f;
    const h265Type = (nal[0] >> 1) & 0x3f;
    if (codec === "h264" && h264Type === 7) return { codec, sps: nal };
    if (codec === "h265" && h265Type === 33) return { codec, sps: nal };
  }
  return { codec };
}

/** Open a playback WS at a given stream_index and report first-keyframe SPS. */
async function probeStreamIndex(
  session: NvrSession,
  channelId: string,
  range: { start: number; end: number },
  streamIndex: number,
): Promise<{
  streamIndex: number;
  firstKeyframeMs: number | null;
  codec: "h264" | "h265" | "unknown";
  size: { width: number; height: number } | null;
  openResponseCode: number | null;
  openResponseMsg: string | null;
  error: string | null;
  firstKeyframePayloadBytes: number | null;
}> {
  const taskId = generateTaskId();
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let codec: "h264" | "h265" | "unknown" = "unknown";
  let size: { width: number; height: number } | null = null;
  let firstKeyframeMs: number | null = null;
  let firstKeyframePayloadBytes: number | null = null;
  let openResponseCode: number | null = null;
  let openResponseMsg: string | null = null;
  let error: string | null = null;
  let received = false;
  const startedAt = Date.now();

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  const timer = setTimeout(() => {
    if (!received) {
      error = error ?? "timeout waiting for first keyframe";
      resolveDone();
    }
  }, FIRST_KEYFRAME_TIMEOUT_MS);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = data.toString("utf-8");
      handleText(text);
      return;
    }
    let chunk: Uint8Array;
    if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
    else if (Buffer.isBuffer(data)) chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (Array.isArray(data)) chunk = new Uint8Array(Buffer.concat(data));
    else return;
    if (received) return;
    try {
      const wsFrame = parseWSFrame(chunk);
      const shfl = parseSHFL(wsFrame.payload);
      if ((shfl.frameType === 0 || shfl.frameType === 4) && shfl.payload.byteLength > 0 && shfl.isKeyFrame) {
        received = true;
        firstKeyframeMs = Date.now() - startedAt;
        firstKeyframePayloadBytes = shfl.payload.byteLength;
        const found = findSps(shfl.payload);
        codec = found.codec;
        if (!found.sps) {
          error = `no SPS NAL (codec=${found.codec}, payload=${shfl.payload.byteLength}B)`;
        } else {
          try {
            size = found.codec === "h265" ? parseH265Sps(found.sps) : parseH264Sps(found.sps);
          } catch (err) {
            error = `SPS parse: ${(err as Error).message}`;
          }
        }
        resolveDone();
      }
    } catch {
      // skip malformed
    }
  });

  function handleText(text: string): void {
    let msg: { url?: string; basic?: { code?: number; msg?: string } };
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.url?.endsWith("create_connection#response")) {
      ws.send(JSON.stringify({
        url: "/device/playback/open",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskId,
          channel_id: channelId,
          start_time: range.start,
          end_time: range.end,
          stream_index: streamIndex,
          type_mask: [
            "manual", "sensor", "avd", "smart_pass_line", "tripwire",
            "perimeter", "smart_aoi_entry", "smart_aoi_leave", "motion",
            "pos", "schedule",
          ],
        },
      }));
      return;
    }
    if (msg.url === "/device/playback/open#response") {
      openResponseCode = msg.basic?.code ?? 0;
      openResponseMsg = msg.basic?.msg ?? null;
      if (openResponseCode !== 0) {
        error = `playback/open code=${openResponseCode} msg=${openResponseMsg ?? ""}`;
        resolveDone();
        return;
      }
      ws.send(JSON.stringify({
        url: "/device/playback/audio/close",
        basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId },
      }));
    }
  }

  ws.on("close", () => { if (!received && !error) error = "ws closed before keyframe"; resolveDone(); });
  ws.on("error", (err) => { if (!error) error = `ws error: ${err.message}`; resolveDone(); });

  await done;
  clearTimeout(timer);
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        url: "/device/playback/close",
        basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId },
      }));
    }
    ws.close();
  } catch { /* best-effort */ }
  await sleep(250);

  return {
    streamIndex,
    firstKeyframeMs,
    codec,
    size,
    openResponseCode,
    openResponseMsg,
    error,
    firstKeyframePayloadBytes,
  };
}

async function runProbe() {
  watchdog(WATCHDOG_MS);
  const creds = loadCredentials();
  const session = await login(creds);
  console.log(`login ok in ${session.loginMs}ms`);

  const channelId = await pickChannelId(session, creds);
  console.log(`channel: ${channelId}`);

  const range = defaultPlaybackRange(creds);
  console.log(`playback range: ${unixToUtcTimeStr(range.start)} .. ${unixToUtcTimeStr(range.end)}`);

  let recorded;
  try {
    recorded = await queryRecordedStreamInfo(session, channelId, range);
    console.log(
      `queryChlRecLog: main=${recorded.mainResolution ?? "?"} sub=${recorded.subResolution ?? "?"}`,
    );
  } catch (err) {
    console.error(`queryChlRecLog failed: ${(err as Error).message}`);
  }

  const sweep: Awaited<ReturnType<typeof probeStreamIndex>>[] = [];
  for (const idx of [0, 1, 2, 3]) {
    console.log(`\n— stream_index=${idx} —`);
    const r = await probeStreamIndex(session, channelId, range, idx);
    const szStr = r.size ? `${r.size.width}x${r.size.height}` : "—";
    console.log(
      `  firstKeyframeMs=${r.firstKeyframeMs ?? "—"} codec=${r.codec} size=${szStr} payload=${r.firstKeyframePayloadBytes ?? "—"}B openCode=${r.openResponseCode ?? "—"}${r.error ? ` ERROR: ${r.error}` : ""}`,
    );
    sweep.push(r);
  }

  console.log(`\n=== summary ===`);
  console.log(`recorded (per queryChlRecLog): main=${recorded?.mainResolution ?? "?"} sub=${recorded?.subResolution ?? "?"}`);
  for (const r of sweep) {
    const sz = r.size ? `${r.size.width}x${r.size.height} ${r.codec}` : `FAILED (${r.error ?? "?"})`;
    console.log(`  stream_index=${r.streamIndex}: ${sz}`);
  }

  writeResult("18-main-stream-index-sweep", {
    channelId,
    recordedMain: recorded?.mainResolution,
    recordedSub: recorded?.subResolution,
    sweep,
  });
}

runProbe().catch((err) => {
  console.error(err);
  process.exit(1);
});
