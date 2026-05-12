/**
 * Probe 19 — sweep `stream_index` on /device/preview/open to discover what
 * quality tiers are actually available for the *live* preview path.
 *
 * Context: probe 18 showed that for playback, stream_index 0 = original 4K
 * H.265 recording and 1 = transcoded 704x480 H.264. For live preview the app
 * currently sends stream_index=1 for "main" (used by single-cam live, which
 * delivers the real 4K feed on our test NVR) and 2 for "sub" (used by the
 * grid). It's unclear whether preview accepts stream_index 0 at all, and
 * whether an index ≥3 yields anything — i.e. whether there's a "low quality"
 * alternative for live single-cam beyond the sub stream.
 *
 * Hypothesis: preview stream_index follows a different mapping than playback.
 * The web client's CMD_START_PREVIEW defaults to `a.streamType||2` and is
 * only ever observed with 1 or 2 in captures. We need to empirically confirm
 * whether 0 and 3 open successfully (and what they deliver) before deciding
 * how the HQ/LQ toggle should behave on the live screen.
 *
 * What the probe does: for one channel (first online, or creds.channelId if
 * set), opens a fresh WS per stream_index in {0, 1, 2, 3}, waits for first
 * keyframe, parses SPS → width×height, reports per index.
 */
import WebSocket from "ws";

import {
  loadCredentials,
  login,
  pickChannelId,
  sleep,
  writeResult,
  watchdog,
  type NvrSession,
} from "./harness";
import { generateTaskId } from "../../guid";
import { parseWSFrame } from "../../ws-frame";
import { parseSHFL, detectCodec } from "../../shfl";

const WATCHDOG_MS = 60_000;
const FIRST_KEYFRAME_TIMEOUT_MS = 15_000;

function randomU32(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

// --- SPS parsing (copied from probe 18) ---

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

interface ProbeResult {
  streamIndex: number;
  firstKeyframeMs: number | null;
  codec: "h264" | "h265" | "unknown";
  size: { width: number; height: number } | null;
  openResponseCode: number | null;
  openResponseMsg: string | null;
  error: string | null;
  firstKeyframePayloadBytes: number | null;
  totalPayloadBytes: number;
  framesReceived: number;
}

/**
 * Open a preview WS at a given stream_index, wait for first keyframe, then
 * keep the stream open a little longer to sample payload size (so we can
 * eyeball per-frame bitrate differences between indexes even if two indexes
 * map to the same resolution).
 */
async function probePreviewStreamIndex(
  session: NvrSession,
  channelId: string,
  streamIndex: number,
): Promise<ProbeResult> {
  const taskId = generateTaskId();
  const url = `ws://${session.host}/requestWebsocketConnection?sessionID=${session.sessionId}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let codec: "h264" | "h265" | "unknown" = "unknown";
  let size: { width: number; height: number } | null = null;
  let firstKeyframeMs: number | null = null;
  let firstKeyframePayloadBytes: number | null = null;
  let totalPayloadBytes = 0;
  let framesReceived = 0;
  let openResponseCode: number | null = null;
  let openResponseMsg: string | null = null;
  let error: string | null = null;
  const startedAt = Date.now();

  // Two-phase: first wait for keyframe (→ phase1Done), then sample for a
  // fixed window before closing (→ phase2Done).
  let resolvePhase1: () => void = () => {};
  const phase1 = new Promise<void>((r) => { resolvePhase1 = r; });
  const timer1 = setTimeout(() => {
    if (firstKeyframeMs === null) {
      error = error ?? "timeout waiting for first keyframe";
      resolvePhase1();
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
    try {
      const wsFrame = parseWSFrame(chunk);
      const shfl = parseSHFL(wsFrame.payload);
      if ((shfl.frameType === 0 || shfl.frameType === 4) && shfl.payload.byteLength > 0) {
        framesReceived++;
        totalPayloadBytes += shfl.payload.byteLength;
        if (firstKeyframeMs === null && shfl.isKeyFrame) {
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
          resolvePhase1();
        }
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
        url: "/device/preview/open",
        basic: { ver: "1.0", id: 1, time: Date.now(), nonce: randomU32() },
        data: {
          task_id: taskId,
          channel_id: channelId,
          stream_index: streamIndex,
          audio: false,
        },
      }));
      return;
    }
    if (msg.url === "/device/preview/open#response") {
      openResponseCode = msg.basic?.code ?? 0;
      openResponseMsg = msg.basic?.msg ?? null;
      if (openResponseCode !== 0) {
        error = `preview/open code=${openResponseCode} msg=${openResponseMsg ?? ""}`;
        resolvePhase1();
        return;
      }
      // Match app: close audio after open so server begins emitting video.
      ws.send(JSON.stringify({
        url: "/device/preview/audio/close",
        basic: { ver: "1.0", id: 3, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId },
      }));
    }
  }

  ws.on("close", () => { if (firstKeyframeMs === null && !error) error = "ws closed before keyframe"; resolvePhase1(); });
  ws.on("error", (err) => { if (!error) error = `ws error: ${err.message}`; resolvePhase1(); });

  await phase1;

  // If we got a keyframe, sample 3 s of additional frames to get a rough
  // bitrate picture. Total payload / sample window is a coarse proxy when
  // two indexes report the same resolution.
  if (firstKeyframeMs !== null) {
    await sleep(3000);
  }

  clearTimeout(timer1);
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        url: "/device/preview/close",
        basic: { ver: "1.0", id: 99, time: Date.now(), nonce: randomU32() },
        data: { task_id: taskId },
      }));
    }
    ws.close();
  } catch { /* best-effort */ }
  await sleep(300);

  return {
    streamIndex,
    firstKeyframeMs,
    codec,
    size,
    openResponseCode,
    openResponseMsg,
    error,
    firstKeyframePayloadBytes,
    totalPayloadBytes,
    framesReceived,
  };
}

async function runProbe() {
  watchdog(WATCHDOG_MS);
  const creds = loadCredentials();
  const session = await login(creds);
  console.log(`login ok in ${session.loginMs}ms`);

  const channelId = await pickChannelId(session, creds);
  console.log(`channel: ${channelId}`);

  const sweep: ProbeResult[] = [];
  for (const idx of [0, 1, 2, 3]) {
    console.log(`\n— stream_index=${idx} —`);
    const r = await probePreviewStreamIndex(session, channelId, idx);
    const szStr = r.size ? `${r.size.width}x${r.size.height}` : "—";
    const sampleSec = r.firstKeyframeMs !== null ? 3 : 0;
    const kbps = sampleSec > 0 ? ((r.totalPayloadBytes * 8) / sampleSec / 1000).toFixed(0) : "—";
    console.log(
      `  firstKeyframeMs=${r.firstKeyframeMs ?? "—"} codec=${r.codec} size=${szStr} ` +
        `frames=${r.framesReceived} totalBytes=${r.totalPayloadBytes} ~bitrate=${kbps}kbps ` +
        `openCode=${r.openResponseCode ?? "—"}${r.error ? ` ERROR: ${r.error}` : ""}`,
    );
    sweep.push(r);
  }

  console.log(`\n=== summary (preview/open) ===`);
  for (const r of sweep) {
    const sz = r.size ? `${r.size.width}x${r.size.height} ${r.codec}` : `FAILED (${r.error ?? "?"})`;
    const sampleSec = r.firstKeyframeMs !== null ? 3 : 0;
    const kbps = sampleSec > 0 ? ((r.totalPayloadBytes * 8) / sampleSec / 1000).toFixed(0) : "—";
    console.log(`  stream_index=${r.streamIndex}: ${sz} (~${kbps}kbps)`);
  }

  writeResult("19-preview-stream-index-sweep", {
    channelId,
    sweep,
  });
}

runProbe().catch((err) => {
  console.error(err);
  process.exit(1);
});
