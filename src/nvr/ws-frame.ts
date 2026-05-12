import type { WSFrame, WSFrameHeader } from "./types";

/**
 * Parse a WebSocket binary frame from the NVR.
 *
 * Wire format:
 *   Offset 0: 4 bytes - u32 LE, always 0x00000000 (frame-type marker)
 *   Offset 4: 4 bytes - hdrLen (u32 LE), JSON header length
 *   Offset 8: hdrLen bytes - UTF-8 JSON header
 *   Offset 8+hdrLen: rest - media payload (SHFL-wrapped)
 *
 * @param chunk - Raw binary data from the WebSocket
 * @returns Parsed frame with JSON header and payload subarray
 */
export function parseWSFrame(chunk: Uint8Array): WSFrame {
  if (chunk.byteLength < 8) {
    throw new Error(
      `WS frame too short: ${chunk.byteLength} bytes (need at least 8)`,
    );
  }

  // Use DataView with proper byteOffset for Uint8Array slices
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  const marker = dv.getUint32(0, true);
  if (marker !== 0x00000000) {
    throw new Error(
      `WS frame unexpected marker: 0x${marker.toString(16).padStart(8, "0")}`,
    );
  }

  const hdrLen = dv.getUint32(4, true);
  if (8 + hdrLen > chunk.byteLength) {
    throw new Error(
      `WS frame header overrun: hdrLen=${hdrLen}, total=${chunk.byteLength}`,
    );
  }

  // Decode JSON header
  const headerBytes = chunk.subarray(8, 8 + hdrLen);
  const headerText = new TextDecoder().decode(headerBytes);
  let header: WSFrameHeader;
  try {
    header = JSON.parse(headerText) as WSFrameHeader;
  } catch (e) {
    throw new Error(`WS frame invalid JSON header: ${(e as Error).message}`);
  }

  // Extract payload (zero-copy subarray)
  const payload = chunk.subarray(8 + hdrLen);

  return { header, payload };
}
