import { describe, it, expect } from "vitest";
import { parseSHFL, detectCodec } from "../shfl";

/** Build a minimal SHFL chunk for testing. */
function buildSHFLChunk(opts: {
  isKeyFrame?: boolean;
  frameType?: number;
  extInfoLen?: number;
  seq?: number;
  timestampLow?: number;
  timestampHigh?: number;
  payload?: Uint8Array;
}): Uint8Array {
  const {
    isKeyFrame = false,
    frameType = 0,
    extInfoLen = 0,
    seq = 1,
    timestampLow = 1000,
    timestampHigh = 0,
    payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]),
  } = opts;

  const totalSize = 68 + extInfoLen + payload.length;
  const chunk = new Uint8Array(totalSize);
  const dv = new DataView(chunk.buffer);

  // StreamHeader (44 bytes)
  dv.setUint32(0, 0x4c464853, true); // SHFL magic
  chunk[4] = 0x03;
  chunk[5] = 0x01;
  chunk[6] = 0x07; // version
  chunk[7] = isKeyFrame ? 1 : 0;
  // bytes 8-23: reserved (zero)
  dv.setUint32(24, totalSize - 44, true); // bodySize
  dv.setUint32(28, timestampLow, true);
  dv.setUint32(32, timestampHigh, true);
  dv.setUint32(36, seq, true);
  // bytes 40-43: reserved

  // FrameHeader (24 bytes) at offset 44
  chunk[44] = frameType;
  chunk[45] = extInfoLen;
  // bytes 46-47: reserved
  dv.setUint32(48, payload.length, true); // dwRealFrameLen
  // bytes 52-67: timestamps (zero for test)

  // ExtInfo (skip, zeros)
  // Payload
  chunk.set(payload, 68 + extInfoLen);

  return chunk;
}

describe("parseSHFL", () => {
  it("should parse a P-frame (no ext info)", () => {
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]);
    const chunk = buildSHFLChunk({ payload, seq: 42 });
    const result = parseSHFL(chunk);

    expect(result.isKeyFrame).toBe(false);
    expect(result.frameType).toBe(0);
    expect(result.seq).toBe(42);
    expect(result.payload).toEqual(payload);
  });

  it("should parse a keyframe with ext info", () => {
    // SPS + PPS + IDR
    const payload = new Uint8Array([
      0x00, 0x00, 0x00, 0x01, 0x67, // SPS
      0x00, 0x00, 0x00, 0x01, 0x68, // PPS
      0x00, 0x00, 0x00, 0x01, 0x65, // IDR
    ]);
    const chunk = buildSHFLChunk({
      isKeyFrame: true,
      extInfoLen: 44,
      payload,
      seq: 1,
    });
    const result = parseSHFL(chunk);

    expect(result.isKeyFrame).toBe(true);
    expect(result.payload).toEqual(payload);
    expect(result.payload.byteLength).toBe(15);
  });

  it("should return zero-copy subarray", () => {
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
    const chunk = buildSHFLChunk({ payload });
    const result = parseSHFL(chunk);

    // payload should share the same underlying buffer
    expect(result.payload.buffer).toBe(chunk.buffer);
  });

  it("should handle frame from a subarray (byteOffset != 0)", () => {
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]);
    const innerChunk = buildSHFLChunk({ payload, seq: 99 });

    // Wrap in larger buffer with offset
    const outer = new Uint8Array(20 + innerChunk.length);
    outer.set(innerChunk, 20);
    const sliced = outer.subarray(20);

    const result = parseSHFL(sliced);
    expect(result.seq).toBe(99);
    expect(result.payload).toEqual(payload);
  });

  it("should extract timestamps", () => {
    const chunk = buildSHFLChunk({
      timestampLow: 0xdeadbeef,
      timestampHigh: 0x12345678,
    });
    const result = parseSHFL(chunk);
    expect(result.timestampLow).toBe(0xdeadbeef);
    expect(result.timestampHigh).toBe(0x12345678);
  });

  it("should throw on too-short data (< 44 bytes)", () => {
    expect(() => parseSHFL(new Uint8Array(30))).toThrow("too short");
  });

  it("should throw on invalid magic", () => {
    const chunk = new Uint8Array(68);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 0xdeadbeef, true); // wrong magic
    expect(() => parseSHFL(chunk)).toThrow("invalid magic");
  });

  it("should throw on too-short data (< 68 bytes)", () => {
    const chunk = new Uint8Array(50);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 0x4c464853, true); // correct magic
    expect(() => parseSHFL(chunk)).toThrow("too short for FrameHeader");
  });

  it("should throw on payload overrun", () => {
    const chunk = new Uint8Array(68);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 0x4c464853, true);
    chunk[45] = 0; // byExtInfoLen = 0
    dv.setUint32(48, 999, true); // dwRealFrameLen way too large
    expect(() => parseSHFL(chunk)).toThrow("payload overrun");
  });

  it("should throw on ext info overrun", () => {
    const chunk = new Uint8Array(68);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, 0x4c464853, true);
    chunk[45] = 200; // byExtInfoLen way too large
    dv.setUint32(48, 0, true);
    expect(() => parseSHFL(chunk)).toThrow("ExtInfo overrun");
  });

  it("should detect stream-reset frame type", () => {
    const chunk = buildSHFLChunk({
      frameType: 4,
      payload: new Uint8Array([0x00]),
    });
    const result = parseSHFL(chunk);
    expect(result.frameType).toBe(4);
  });

  it("should handle chunk with tail bytes (watermark ignored)", () => {
    // Build chunk with extra tail bytes after payload
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
    const chunk = buildSHFLChunk({ payload });

    // Add 62 bytes of tail (watermark) - create a bigger buffer
    const withTail = new Uint8Array(chunk.length + 62);
    withTail.set(chunk, 0);
    // Tail bytes are just noise
    for (let i = chunk.length; i < withTail.length; i++) {
      withTail[i] = 0xff;
    }

    // parseSHFL should still extract just the payload, ignoring tail
    const result = parseSHFL(withTail);
    expect(result.payload).toEqual(payload);
    expect(result.payload.byteLength).toBe(5);
  });
});

describe("detectCodec", () => {
  it("should detect H.264 SPS (NAL type 7)", () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h264");
    expect(info.nalType).toBe(7);
  });

  it("should detect H.264 PPS (NAL type 8)", () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x68]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h264");
    expect(info.nalType).toBe(8);
  });

  it("should detect H.264 IDR (NAL type 5)", () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h264");
    expect(info.nalType).toBe(5);
  });

  it("should detect H.264 P-slice (NAL type 1)", () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h264");
    expect(info.nalType).toBe(1);
  });

  it("should detect H.265 VPS (NAL type 32)", () => {
    // H.265 VPS: type 32 = (byte >> 1) & 0x3F
    // byte = (32 << 1) | 0 = 0x40
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x40, 0x01]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h265");
    expect(info.nalType).toBe(32);
  });

  it("should detect H.265 SPS (NAL type 33)", () => {
    // byte = (33 << 1) = 0x42
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x42, 0x01]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h265");
    expect(info.nalType).toBe(33);
  });

  it("should detect H.265 PPS (NAL type 34)", () => {
    // byte = (34 << 1) = 0x44
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x44, 0x01]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h265");
    expect(info.nalType).toBe(34);
  });

  it("should return unknown for no start code", () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    const info = detectCodec(data);
    expect(info.codec).toBe("unknown");
    expect(info.nalType).toBe(-1);
  });

  it("should return unknown for empty payload", () => {
    const info = detectCodec(new Uint8Array(0));
    expect(info.codec).toBe("unknown");
    expect(info.nalType).toBe(-1);
  });

  it("should find start code not at offset 0", () => {
    // Some leading bytes before the start code
    const data = new Uint8Array([
      0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x67,
    ]);
    const info = detectCodec(data);
    expect(info.codec).toBe("h264");
    expect(info.nalType).toBe(7); // SPS
  });

  it("should work with data from subarray (byteOffset != 0)", () => {
    const buf = new Uint8Array([
      0xaa, 0xbb, 0x00, 0x00, 0x00, 0x01, 0x65,
    ]);
    const sub = buf.subarray(2);
    const info = detectCodec(sub);
    expect(info.codec).toBe("h264");
    expect(info.nalType).toBe(5);
  });
});
