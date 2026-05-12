/**
 * Generate synthetic bench fixtures with valid WS + SHFL framing but
 * dummy (deterministic-random) payloads. The parsers under bench
 * (parseWSFrame, parseSHFL) only validate the wrapper bytes and slice
 * the payload — they never decode it — so synthetic data exercises the
 * same code paths as real captures.
 *
 * Run:  npx tsx bench/fixtures/generate.ts
 *
 * Sizes match the original capture so the bench numbers stay
 * comparable to historical runs.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const SHFL_MAGIC = 0x4c464853;
const STREAM_HEADER_SIZE = 44;
const FRAME_HEADER_SIZE = 24;
const SHFL_MIN_SIZE = STREAM_HEADER_SIZE + FRAME_HEADER_SIZE;

type Spec = {
  name: string;
  totalSize: number;
  isKeyFrame: boolean;
  frameType: number;
  seq: number;
  ptsUnix: number;
  streamIndex: number;
};

const SPECS: Spec[] = [
  { name: "sub-keyframe.bin",       totalSize: 43421,  isKeyFrame: true,  frameType: 4, seq: 1, ptsUnix: 1777074970.7781181, streamIndex: 2 },
  { name: "sub-pframe.bin",         totalSize: 503,    isKeyFrame: false, frameType: 4, seq: 2, ptsUnix: 1777074970.8277225, streamIndex: 2 },
  { name: "main-h264-keyframe.bin", totalSize: 43421,  isKeyFrame: true,  frameType: 4, seq: 1, ptsUnix: 1777074970.7781181, streamIndex: 1 },
  { name: "main-h264-pframe.bin",   totalSize: 503,    isKeyFrame: false, frameType: 4, seq: 2, ptsUnix: 1777074970.8277225, streamIndex: 1 },
  { name: "main-h265-keyframe.bin", totalSize: 632486, isKeyFrame: true,  frameType: 0, seq: 1, ptsUnix: 1777074971.516142,  streamIndex: 0 },
];

function ptsToFiletime(ptsUnix: number): { low: number; high: number } {
  // 100ns ticks since 1601-01-01 (Windows FILETIME-style timestamp).
  const TICKS_PER_SEC = 10_000_000;
  const EPOCH_OFFSET = 11_644_473_600;
  const ticks = BigInt(Math.round((ptsUnix + EPOCH_OFFSET) * TICKS_PER_SEC));
  return {
    low:  Number(ticks & 0xffffffffn),
    high: Number((ticks >> 32n) & 0xffffffffn),
  };
}

// Deterministic xorshift32 — keeps fixtures byte-stable across runs.
function fillRandom(buf: Uint8Array, seed: number): void {
  let s = seed | 0;
  for (let i = 0; i < buf.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    buf[i] = s & 0xff;
  }
}

function buildFixture(spec: Spec): Uint8Array {
  const header = {
    url: "requestWebsocketConnection",
    basic: { ver: "1.0", id: spec.seq, time: Math.floor(spec.ptsUnix) },
    data: { streamIndex: spec.streamIndex, channelID: "{00000001-0000-0000-0000-000000000000}" },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const hdrLen = headerBytes.byteLength;

  const wsPrefixSize = 8 + hdrLen;
  const byExtInfoLen = 0;
  const payloadSize = spec.totalSize - wsPrefixSize - SHFL_MIN_SIZE - byExtInfoLen;
  if (payloadSize < 0) {
    throw new Error(`${spec.name}: totalSize ${spec.totalSize} too small for headers`);
  }

  const out = new Uint8Array(spec.totalSize);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, 0x00000000, true);
  dv.setUint32(4, hdrLen, true);
  out.set(headerBytes, 8);

  const shflOffset = wsPrefixSize;
  dv.setUint32(shflOffset + 0, SHFL_MAGIC, true);
  out[shflOffset + 7] = spec.isKeyFrame ? 1 : 0;
  dv.setUint32(shflOffset + 24, payloadSize, true);
  const ft = ptsToFiletime(spec.ptsUnix);
  dv.setUint32(shflOffset + 28, ft.low, true);
  dv.setUint32(shflOffset + 32, ft.high, true);
  dv.setUint32(shflOffset + 36, spec.seq, true);

  const frameHdrOffset = shflOffset + STREAM_HEADER_SIZE;
  out[frameHdrOffset + 0] = spec.frameType;
  out[frameHdrOffset + 1] = byExtInfoLen;
  dv.setUint32(frameHdrOffset + 4, payloadSize, true);

  const payloadOffset = frameHdrOffset + FRAME_HEADER_SIZE + byExtInfoLen;
  fillRandom(out.subarray(payloadOffset, payloadOffset + payloadSize), spec.seq * 0x9e3779b1);

  return out;
}

for (const spec of SPECS) {
  const buf = buildFixture(spec);
  writeFileSync(join(HERE, spec.name), buf);
  console.log(`${spec.name}: ${buf.byteLength}B`);
}
