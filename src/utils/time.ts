/**
 * Timestamp conversion utilities for NVR playback.
 *
 * The NVR uses local-time strings in "YYYY-MM-DD HH:MM:SS" format.
 * Internally we work with Unix seconds (UTC epoch) for arithmetic and
 * the playback WebSocket protocol.
 */

/**
 * Parse "YYYY-MM-DD HH:MM:SS" as local time and return Unix seconds.
 */
export function localTimeToUnix(localTime: string): number {
  // Replace the space with "T" so the Date constructor treats it as local time
  // (ISO strings without a timezone offset are parsed as local in most engines,
  //  but "YYYY-MM-DD HH:MM:SS" without the "T" may be treated as UTC in some.)
  const iso = localTime.replace(" ", "T");
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid local time string: "${localTime}"`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Convert Unix seconds to "YYYY-MM-DD HH:MM:SS:000" (local time).
 */
export function unixToLocalTimeStr(unix: number): string {
  const d = new Date(unix * 1000);
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}:000`;
}

/**
 * Parse "YYYY-MM-DD HH:MM:SS" as UTC and return Unix seconds.
 * NVR responses return recording times with timeZone="UTC" — use this for
 * segment startTime/endTime and for parsing time strings the NVR sends back.
 */
export function utcTimeStrToUnix(utcTime: string): number {
  const iso = utcTime.replace(" ", "T") + "Z";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid UTC time string: "${utcTime}"`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Convert Unix seconds to "YYYY-MM-DD HH:MM:SS:000" in UTC.
 * This is the format the NVR all_frame command expects (the NVR stores
 * recording timestamps in UTC, so seeks must send UTC frame_time too).
 */
export function unixToUtcTimeStr(unix: number): string {
  const d = new Date(unix * 1000);
  const YYYY = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}:000`;
}

/**
 * Convert Unix seconds to a human-readable display string like "3:07:57 PM".
 */
export function unixToDisplayTime(unix: number): string {
  const d = new Date(unix * 1000);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12; // convert 0 → 12
  return `${hours}:${minutes}:${seconds} ${ampm}`;
}

/**
 * Convert a "YYYY-MM-DD" date string to the Unix range for that full day
 * (midnight to midnight, local time).
 */
export function dayToUnixRange(dateStr: string): { start: number; end: number } {
  const startMs = new Date(`${dateStr}T00:00:00`).getTime();
  const endMs = new Date(`${dateStr}T23:59:59`).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error(`Invalid date string: "${dateStr}"`);
  }
  return {
    start: Math.floor(startMs / 1000),
    end: Math.floor(endMs / 1000),
  };
}

/**
 * Project a unix timestamp onto a different calendar day by preserving
 * its clock-time-of-day. Used by the Recorded-tab date picker so
 * switching to a past/future day lands the playhead at the same
 * hh:mm:ss the user was viewing, not at midnight or end-of-day. If the
 * input timestamp doesn't fall within `fromDate`, returns the new day's
 * start (defensive fallback).
 */
export function projectTimeOntoDay(
  prevUnix: number,
  fromDate: string,
  toDate: string,
): number {
  const { start: fromStart, end: fromEnd } = dayToUnixRange(fromDate);
  const { start: toStart } = dayToUnixRange(toDate);
  if (prevUnix < fromStart || prevUnix > fromEnd) return toStart;
  const secondsIntoDay = prevUnix - fromStart;
  return toStart + secondsIntoDay;
}

/**
 * If `preferred` falls inside any of the given time ranges, return it
 * unchanged. Otherwise, return the nearest range edge (either the end
 * of a preceding range or the start of a following range, whichever is
 * closer). Returns `null` if `ranges` is empty.
 *
 * Used by the Recorded tab's day-switch path to snap the projected
 * clock-time to actual footage when the naive projection lands in a
 * cross-camera gap on the new day. Mirrors single-cam's long-standing
 * `pickTargetTime` behavior — lifted to a shared util so grid can use
 * it against the composite (any-camera-has-footage) range set.
 */
export function snapToNearestRange(
  ranges: readonly { start: number; end: number }[],
  preferred: number,
): number | null {
  if (ranges.length === 0) return null;
  let nearest: number | null = null;
  let nearestDist = Infinity;
  for (const r of ranges) {
    if (preferred >= r.start && preferred <= r.end) return preferred;
    const candidate = preferred < r.start ? r.start : r.end;
    const dist = Math.abs(candidate - preferred);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = candidate;
    }
  }
  return nearest;
}
