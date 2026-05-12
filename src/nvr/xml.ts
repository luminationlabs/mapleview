import { XMLParser } from "fast-xml-parser";
import type { NvrXmlResponse, DateRecordingInfo, RecordingSegment } from "./types";
import { localTimeToUnix, unixToUtcTimeStr } from "../utils/time";
import { httpUrl, originUrl } from "../utils/parse-host";

/**
 * Build the standard NVR XML request envelope.
 * Format matches the web client exactly (single line, no extra whitespace).
 */
export function buildRequestXml(token: string, content?: string): string {
  const contentBlock = content ? `<content>${content}</content>` : "";
  return (
    `<?xml version="1.0" encoding="utf-8" ?>` +
    `<request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
    `<token>${token}</token>` +
    contentBlock +
    `</request>`
  );
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  trimValues: true,
  parseTagValue: true,
  // Do not parse numbers in tag values to avoid losing precision on GUIDs
  isArray: (_name, jpath) => {
    if (typeof jpath !== "string") return false;
    // Force certain known list elements to always be arrays
    const arrayPaths = [
      "response.content.list.item",
      "response.content.recList.rec",
      "response.content.recList.item",
      "response.content.nodeList.node",
      "response.content.chlList.chl",
      "response.content.dateList.date",
      "response.content.item",
    ];
    return arrayPaths.some((p) => jpath.endsWith(p));
  },
});

/**
 * Parse an NVR XML response into a structured object.
 */
export function parseResponseXml(xmlText: string): NvrXmlResponse {
  const parsed = xmlParser.parse(xmlText);
  const response = parsed.response;
  if (!response) {
    throw new Error("Invalid NVR XML response: missing <response> root");
  }
  return {
    status: response.status ?? "unknown",
    content: response.content ?? {},
    types: response.types,
    cmdUrl: response["@_cmdUrl"],
  };
}

/**
 * Perform an HTTP POST to an NVR endpoint with the XML envelope.
 *
 * @param host - NVR hostname or IP (no trailing slash)
 * @param endpoint - e.g. "/reqLogin"
 * @param token - token string (use "null" for pre-login)
 * @param content - inner XML content string (optional)
 * @param sessionId - bare UUID for the cookie (optional, omit for pre-login)
 * @returns Parsed XML response
 */
/**
 * XMLHttpRequest-based POST that reliably sends Cookie headers in React Native.
 * RN's fetch may strip manually-set Cookie headers on iOS.
 */
function xhrPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
      } else {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network request failed"));
    xhr.send(body);
  });
}

export async function nvrPost(
  host: string,
  endpoint: string,
  token: string,
  content?: string,
  sessionId?: string,
): Promise<NvrXmlResponse> {
  const body = buildRequestXml(token, content);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: originUrl(host),
  };
  if (sessionId) {
    headers["Cookie"] = `sessionId=${sessionId}`;
  }

  const url = httpUrl(host, endpoint);
  const text = await xhrPost(url, headers, body);
  return parseResponseXml(text);
}

// ---- Query helpers ----

/**
 * Query which channels have recordings.
 */
export async function queryChlsExistRec(
  host: string,
  token: string,
  sessionId: string,
): Promise<NvrXmlResponse> {
  return nvrPost(host, "/queryChlsExistRec", token, undefined, sessionId);
}

/**
 * Query which channels are currently online.
 */
export async function queryOnlineChlList(
  host: string,
  token: string,
  sessionId: string,
): Promise<NvrXmlResponse> {
  return nvrPost(host, "/queryOnlineChlList", token, undefined, sessionId);
}

/**
 * Default recording types to query.
 */
/**
 * Recording types to filter in <condition><recType> (what we want back).
 */
const DEFAULT_REC_TYPES = [
  "MANUAL",
  "SENSOR",
  "INTELLIGENT",
  "MOTION",
  "POS",
  "SCHEDULE",
];

/**
 * ALL recording types — used in the <types> schema declaration block.
 * The NVR validates this is the complete enum.
 */
const ALL_REC_TYPE_ENUMS = [
  "MOTION", "SCHEDULE", "SENSOR", "MANUAL", "INTELLIGENT", "POS",
  "NORMALALL", "FACEDETECTION", "FACEMATCH", "VEHICLE", "TRIPWIRE",
  "INVADE", "AOIENTRY", "AOILEAVE", "ITEMCARE", "CROWDDENSITY", "EXCEPTION",
];

/**
 * Query which dates have recordings for a given channel.
 * Uses the condition/chlId format the NVR expects.
 */
export async function queryDatesExistRec(
  host: string,
  token: string,
  sessionId: string,
  channelId: string,
): Promise<DateRecordingInfo> {
  // This endpoint puts <condition> at the request root, NOT inside <content>
  const body =
    `<?xml version="1.0" encoding="utf-8" ?>` +
    `<request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
    `<token>${token}</token>` +
    `<condition><chlId>${channelId}</chlId></condition>` +
    `</request>`;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: originUrl(host),
    Cookie: `sessionId=${sessionId}`,
  };

  const text = await xhrPost(httpUrl(host, "/queryDatesExistRec"), headers, body);
  const resp = parseResponseXml(text);

  return parseDateRecordingInfo(resp);
}

/**
 * Parse a queryDatesExistRec response into DateRecordingInfo.
 */
export function parseDateRecordingInfo(resp: NvrXmlResponse): DateRecordingInfo {
  const c = resp.content as Record<string, unknown>;

  // Attributes on the content element
  const startTime = String(c["@_startTime"] ?? "");
  const endTime = String(c["@_endTime"] ?? "");
  const duration = Number(c["@_duration"] ?? 0);

  // Items may be a single value or array
  let rawItems = c.item;
  if (rawItems == null) {
    return { dates: [], startTime, endTime, duration };
  }
  if (!Array.isArray(rawItems)) {
    rawItems = [rawItems];
  }
  const dates = (rawItems as unknown[]).map((d) => String(d));

  return { dates, startTime, endTime, duration };
}

/**
 * Query recording segments for a channel within a time range.
 * Uses the complex condition XML format the NVR expects.
 */
export async function queryChlRecLog(
  host: string,
  token: string,
  sessionId: string,
  channelId: string,
  startTime: string,
  endTime: string,
  recTypes?: string[],
): Promise<RecordingSegment[]> {
  const types = recTypes && recTypes.length > 0 ? recTypes : DEFAULT_REC_TYPES;
  // <types> block must have ALL enum values (schema declaration)
  const typeEnums = ALL_REC_TYPE_ENUMS.map((t) => `<enum>${t}</enum>`).join("");
  // <condition><recType> has just the filter values
  const typeItems = types.map((t) => `<item>${t}</item>`).join("");

  // NVR stores recording timestamps in UTC (see <recList timeZone="UTC"> in
  // responses). The reference web client sends local-time strings in
  // <startTime>/<endTime> and UTC equivalents in <startTimeEx>/<endTimeEx>.
  // Sending the same local string for both returns segments windowed against
  // the wrong UTC range (causes "no recordings" or truncated timelines).
  const startUtc = unixToUtcTimeStr(localTimeToUnix(startTime)).slice(0, 19);
  const endUtc = unixToUtcTimeStr(localTimeToUnix(endTime)).slice(0, 19);

  // This endpoint uses a non-standard request format: <types>, <requireField>,
  // and <condition> are at the request root level (NOT inside <content>).
  const body =
    `<?xml version="1.0" encoding="utf-8" ?>` +
    `<request version="1.0" systemType="NVMS-9000" clientType="WEB">` +
    `<token>${token}</token>` +
    `<types><recType>${typeEnums}</recType></types>` +
    `<requireField><chl/><recList><item><recType/><startTime/><endTime/><size/></item></recList></requireField>` +
    `<condition>` +
    `<modeType>modeOne</modeType>` +
    `<startTime>${startTime}</startTime>` +
    `<endTime>${endTime}</endTime>` +
    `<startTimeEx>${startUtc}</startTimeEx>` +
    `<endTimeEx>${endUtc}</endTimeEx>` +
    `<recType type='list'>` +
    `<itemType type='recType'/>` +
    typeItems +
    `</recType>` +
    `<keyword></keyword>` +
    `<chl id='${channelId}'></chl>` +
    `</condition>` +
    `</request>`;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: originUrl(host),
    Cookie: `sessionId=${sessionId}`,
  };

  const text = await xhrPost(httpUrl(host, "/queryChlRecLog"), headers, body);


  const resp = parseResponseXml(text);
  return parseRecordingSegments(resp);
}

/**
 * Parse a queryChlRecLog response into RecordingSegment[].
 */
export function parseRecordingSegments(resp: NvrXmlResponse): RecordingSegment[] {
  const c = resp.content as Record<string, unknown>;
  const recList = c.recList as Record<string, unknown> | undefined;
  if (!recList) return [];

  let items = recList.item;
  if (items == null) return [];
  if (!Array.isArray(items)) {
    items = [items];
  }

  return (items as Record<string, unknown>[]).map((item) => ({
    recType: String(item.recType ?? ""),
    startTime: String(item.startTime ?? ""),
    endTime: String(item.endTime ?? ""),
    size: Number(item.size ?? 0),
  }));
}
