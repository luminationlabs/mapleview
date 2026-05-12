// Types
export type {
  NvrSession,
  ReqLoginResponse,
  DoLoginResponse,
  NvrXmlResponse,
  WSFrame,
  WSFrameHeader,
  SHFLFrame,
  Codec,
  NALInfo,
  ChannelInfo,
  RecordingDateInfo,
  RecordingSegment,
  StreamMode,
  StreamKey,
  CameraStatus,
  CameraInfo,
  FrameSink,
  GridLayout,
} from "./types";

// Crypto
export { md5Hex, sha512Hex, computePasswordHash } from "./crypto";

// XML
export {
  buildRequestXml,
  parseResponseXml,
  nvrPost,
  queryChlsExistRec,
  queryOnlineChlList,
  queryDatesExistRec,
  queryChlRecLog,
} from "./xml";

// Login
export { login, stripBraces } from "./login";

// WebSocket frame parser
export { parseWSFrame } from "./ws-frame";

// SHFL demuxer
export { parseSHFL, detectCodec } from "./shfl";

// GUID generation
export { generateTaskId } from "./guid";

// Stream connection
export { StreamConnection } from "./stream-connection";

// Playback connection
export { PlaybackConnection } from "./playback-connection";

// Playback manager singleton
export { playbackManager, PlaybackManager } from "./playback-manager";

// Client singleton
export { nvrClient, NVRClient } from "./client";
