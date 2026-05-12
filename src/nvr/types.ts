/** Session data returned after a successful login. Plain data object. */
export interface NvrSession {
  host: string;
  sessionId: string; // bare UUID (no braces), used as cookie
  token: string; // brace-wrapped GUID from reqLogin
  userId: string;
  userName: string;
}

/** Raw response from /reqLogin (step 1). */
export interface ReqLoginResponse {
  sessionId: string; // brace-wrapped
  nonce: string; // brace-wrapped
  token: string; // brace-wrapped
  softwareVersion: string;
}

/** Raw response from /doLogin (step 2). */
export interface DoLoginResponse {
  userId: string;
  sessionKey: string; // base64 AES-ECB encrypted
  authEffective: string;
  userType: string;
}

/** Parsed XML response envelope. */
export interface NvrXmlResponse {
  status: string;
  content: Record<string, unknown>;
  types?: Record<string, unknown>;
  cmdUrl?: string;
}

/** Parsed WS binary frame header + payload. */
export interface WSFrame {
  header: WSFrameHeader;
  payload: Uint8Array; // SHFL-wrapped media data (subarray, zero-copy)
}

export interface WSFrameHeader {
  url: string;
  basic: {
    ver: string;
    id: number;
    time: number;
    code?: number;
    msg?: string;
    nonce?: number;
  };
  data: Record<string, unknown>;
}

/** Result of SHFL demuxing. */
export interface SHFLFrame {
  isKeyFrame: boolean;
  frameType: number; // 0 = video, 4 = stream-reset
  seq: number;
  timestampLow: number;
  timestampHigh: number;
  payload: Uint8Array; // Annex-B NAL units (subarray, zero-copy)
}

/** Codec detection result. */
export type Codec = "h264" | "h265" | "unknown";

/** NAL unit type info for codec detection. */
export interface NALInfo {
  codec: Codec;
  nalType: number;
}

/** Channel info from queryChlsExistRec. */
export interface ChannelInfo {
  id: string;
  name: string;
}

/** Recording date info from queryDatesExistRec. */
export interface RecordingDateInfo {
  date: string;
  startTime?: string;
  endTime?: string;
}

/** Recording segment from queryChlRecLog. */
export interface RecordingSegment {
  recType: string;       // "SCHEDULE", "MOTION", etc.
  startTime: string;     // "YYYY-MM-DD HH:MM:SS" (local time)
  endTime: string;       // "YYYY-MM-DD HH:MM:SS" (local time)
  size: number;          // approximate size in MB
}

/** A contiguous time range in Unix seconds. */
export interface TimeRange {
  start: number;         // Unix seconds
  end: number;           // Unix seconds
}

/** Summary of which dates have recordings for a channel. */
export interface DateRecordingInfo {
  dates: string[];       // ["2026-04-13", "2026-04-12", ...]
  startTime: string;     // earliest recording time
  endTime: string;       // latest recording time
  duration: number;      // total seconds
}

/** Stream mode: main (high-res) or sub (low-res). */
export type StreamMode = "main" | "sub";

/** Unique key for a stream: "channelId:mode". */
export type StreamKey = `${string}:${StreamMode}`;

/** Camera connection status. */
export type CameraStatus = "online" | "offline" | "connecting" | "failed";

/** Camera info combining online status and encoding details. */
export interface CameraInfo {
  channelId: string; // brace-wrapped GUID
  name: string;
  status: CameraStatus;
}

/** Callback that receives decoded NAL unit data. */
export type FrameSink = (
  nal: Uint8Array,
  isKeyFrame: boolean,
  pts: number,
) => void;

/** Supported grid layout sizes. */
export type GridLayout = 1 | 4 | 6 | 9 | 12 | 16;
