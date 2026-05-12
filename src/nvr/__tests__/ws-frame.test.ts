import { describe, it, expect } from "vitest";
import { parseWSFrame } from "../ws-frame";

/** Helper: build a WS binary frame from a JSON header and payload bytes. */
function buildWSFrame(header: object, payload: Uint8Array): Uint8Array {
  const headerJson = JSON.stringify(header);
  const headerBytes = new TextEncoder().encode(headerJson);
  const frame = new Uint8Array(8 + headerBytes.length + payload.length);
  const dv = new DataView(frame.buffer);

  // Offset 0: marker = 0x00000000
  dv.setUint32(0, 0, true);
  // Offset 4: header length
  dv.setUint32(4, headerBytes.length, true);
  // Offset 8: header
  frame.set(headerBytes, 8);
  // Offset 8+hdrLen: payload
  frame.set(payload, 8 + headerBytes.length);

  return frame;
}

describe("parseWSFrame", () => {
  it("should parse a valid frame with header and payload", () => {
    const header = {
      url: "/device/playback/data",
      basic: { ver: "1.0", id: 1, time: 1234567890 },
      data: { task_id: "{ABCDEF}" },
    };
    const payload = new Uint8Array([0x53, 0x48, 0x46, 0x4c, 0x01, 0x02]);

    const frame = buildWSFrame(header, payload);
    const result = parseWSFrame(frame);

    expect(result.header.url).toBe("/device/playback/data");
    expect(result.header.basic.ver).toBe("1.0");
    expect(result.header.basic.id).toBe(1);
    expect(result.header.data.task_id).toBe("{ABCDEF}");
    expect(result.payload).toEqual(payload);
  });

  it("should return zero-copy subarray for payload", () => {
    const header = {
      url: "/device/preview/data",
      basic: { ver: "1.0", id: 2, time: 0 },
      data: {},
    };
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const frame = buildWSFrame(header, payload);
    const result = parseWSFrame(frame);

    // The payload should share the same buffer
    expect(result.payload.buffer).toBe(frame.buffer);
  });

  it("should handle frame with empty payload", () => {
    const header = {
      url: "/device/playback/open#response",
      basic: { ver: "1.0", id: 1, time: 0, code: 0, msg: "success" },
      data: { task_id: "{TEST}" },
    };
    const frame = buildWSFrame(header, new Uint8Array(0));
    const result = parseWSFrame(frame);

    expect(result.header.basic.code).toBe(0);
    expect(result.payload.byteLength).toBe(0);
  });

  it("should throw on too-short frame", () => {
    expect(() => parseWSFrame(new Uint8Array(4))).toThrow("too short");
  });

  it("should throw on non-zero marker", () => {
    const frame = new Uint8Array(8);
    const dv = new DataView(frame.buffer);
    dv.setUint32(0, 1, true); // non-zero marker
    dv.setUint32(4, 0, true);
    expect(() => parseWSFrame(frame)).toThrow("unexpected marker");
  });

  it("should throw on header length overrun", () => {
    const frame = new Uint8Array(8);
    const dv = new DataView(frame.buffer);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, 999, true); // header length > remaining bytes
    expect(() => parseWSFrame(frame)).toThrow("header overrun");
  });

  it("should throw on invalid JSON header", () => {
    const badJson = new TextEncoder().encode("{not valid json");
    const frame = new Uint8Array(8 + badJson.length);
    const dv = new DataView(frame.buffer);
    dv.setUint32(0, 0, true);
    dv.setUint32(4, badJson.length, true);
    frame.set(badJson, 8);
    expect(() => parseWSFrame(frame)).toThrow("invalid JSON");
  });

  it("should handle frame parsed from a subarray (byteOffset != 0)", () => {
    const header = {
      url: "/device/preview/data",
      basic: { ver: "1.0", id: 3, time: 0 },
      data: {},
    };
    const payload = new Uint8Array([0xde, 0xad]);
    const innerFrame = buildWSFrame(header, payload);

    // Wrap in a larger buffer with an offset
    const outerBuf = new Uint8Array(10 + innerFrame.length);
    outerBuf.set(innerFrame, 10);
    const sliced = outerBuf.subarray(10);

    const result = parseWSFrame(sliced);
    expect(result.header.url).toBe("/device/preview/data");
    expect(result.payload).toEqual(new Uint8Array([0xde, 0xad]));
  });
});
