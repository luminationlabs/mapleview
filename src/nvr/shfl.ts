import type { Codec, NALInfo, SHFLFrame } from "./types";

/** SHFL magic number: "SHFL" in little-endian u32 = 0x4C464853 (S=53 H=48 F=46 L=4C) */
const SHFL_MAGIC = 0x4c464853;

/** Minimum size: 44-byte StreamHeader + 24-byte FrameHeader = 68 bytes */
const MIN_SHFL_SIZE = 68;

/** StreamHeader size */
const STREAM_HEADER_SIZE = 44;

/**
 * Parse a SHFL container from raw bytes.
 *
 * Layout:
 *   StreamHeader (44 bytes) @ offset 0
 *   FrameHeader (24 bytes) @ offset 44
 *   ExtInfo (byExtInfoLen bytes) @ offset 68
 *   Payload (dwRealFrameLen bytes) @ offset 68 + byExtInfoLen
 *   Tail (variable) - watermark, ignored
 *
 * @param chunk - Raw SHFL data (typically from WS frame payload)
 * @returns Parsed frame with metadata and payload subarray (zero-copy)
 */
export function parseSHFL(chunk: Uint8Array): SHFLFrame {
  if (chunk.byteLength < STREAM_HEADER_SIZE) {
    throw new Error(
      `SHFL too short for StreamHeader: ${chunk.byteLength} bytes (need ${STREAM_HEADER_SIZE})`,
    );
  }

  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  // Validate magic
  const magic = dv.getUint32(0, true);
  if (magic !== SHFL_MAGIC) {
    throw new Error(
      `SHFL invalid magic: 0x${magic.toString(16).padStart(8, "0")} (expected 0x4C464853)`,
    );
  }

  if (chunk.byteLength < MIN_SHFL_SIZE) {
    throw new Error(
      `SHFL too short for FrameHeader: ${chunk.byteLength} bytes (need ${MIN_SHFL_SIZE})`,
    );
  }

  // StreamHeader fields
  const isKeyFrame = chunk[7] === 1;
  const bodySize = dv.getUint32(24, true);
  const timestampLow = dv.getUint32(28, true);
  const timestampHigh = dv.getUint32(32, true);
  const seq = dv.getUint32(36, true);

  // FrameHeader fields (at offset 44)
  const frameType = chunk[44];
  const byExtInfoLen = chunk[45];
  const dwRealFrameLen = dv.getUint32(48, true); // offset 44 + 4

  // Validate payload bounds
  const payloadStart = MIN_SHFL_SIZE + byExtInfoLen;
  const payloadEnd = payloadStart + dwRealFrameLen;

  if (payloadStart > chunk.byteLength) {
    throw new Error(
      `SHFL ExtInfo overrun: offset ${payloadStart} > length ${chunk.byteLength}`,
    );
  }

  if (payloadEnd > chunk.byteLength) {
    throw new Error(
      `SHFL payload overrun: need ${payloadEnd}, have ${chunk.byteLength}`,
    );
  }

  // Zero-copy subarray for payload
  const payload = chunk.subarray(payloadStart, payloadEnd);

  return {
    isKeyFrame,
    frameType,
    seq,
    timestampLow,
    timestampHigh,
    payload,
  };
}

/**
 * Detect codec from Annex-B NAL units.
 *
 * Scans for the first 00 00 00 01 start code and examines the NAL unit type byte.
 *
 * H.264: type = byte & 0x1F (SPS=7, PPS=8, IDR=5, P-slice=1)
 * H.265: type = (byte >> 1) & 0x3F (VPS=32, SPS=33, PPS=34)
 *
 * @param payload - Annex-B NAL unit data
 * @returns NAL info with detected codec and NAL type
 */
export function detectCodec(payload: Uint8Array): NALInfo {
  // Find 00 00 00 01 start code
  for (let i = 0; i <= payload.byteLength - 5; i++) {
    if (
      payload[i] === 0x00 &&
      payload[i + 1] === 0x00 &&
      payload[i + 2] === 0x00 &&
      payload[i + 3] === 0x01
    ) {
      const nalByte = payload[i + 4];
      const h264Type = nalByte & 0x1f;
      const h265Type = (nalByte >> 1) & 0x3f;

      // H.265 NAL header is 2 bytes. For VPS/SPS/PPS (types 32-34),
      // the second byte's lower 3 bits (nuh_temporal_id_plus1) should be 1.
      // We use this two-byte check to disambiguate from H.264 bytes that
      // would alias (e.g. 0x41 is H.264 P-slice but h265Type=32).
      const hasSecondByte = i + 5 < payload.byteLength;
      const secondByte = hasSecondByte ? payload[i + 5] : 0;
      const temporalIdPlus1 = secondByte & 0x07;

      // Check H.265 VPS/SPS/PPS: require valid second byte
      if (
        h265Type >= 32 &&
        h265Type <= 34 &&
        hasSecondByte &&
        temporalIdPlus1 === 1
      ) {
        return { codec: "h265", nalType: h265Type };
      }

      // H.265 IDR/CRA types (16-21): also check second byte
      if (
        h265Type >= 16 &&
        h265Type <= 21 &&
        hasSecondByte &&
        temporalIdPlus1 >= 1 &&
        temporalIdPlus1 <= 7
      ) {
        return { codec: "h265", nalType: h265Type };
      }

      // H.264 NAL types (1-23)
      if (h264Type >= 1 && h264Type <= 23) {
        return { codec: "h264", nalType: h264Type };
      }

      return { codec: "unknown", nalType: nalByte };
    }
  }

  return { codec: "unknown", nalType: -1 };
}
