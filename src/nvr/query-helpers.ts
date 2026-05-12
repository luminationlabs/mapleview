import { nvrClient } from "./client";
import { queryChlRecLog, queryDatesExistRec } from "./xml";
import type { RecordingSegment } from "./types";

/**
 * Query recording segments for a channel, transparently retrying with a
 * fresher token if the first result looks like a silent-empty failure.
 *
 * The NVR silently returns `200 OK` with an empty `recList` for HTTP
 * queries whose token has been invalidated by a newer login for the
 * same user (documented in docs/playback-pacing-log.md:148). The
 * response is indistinguishable from a legitimately-empty date unless
 * we know a fresher token has landed in nvrClient's pool.
 *
 * On an empty first result this wrapper re-awaits any pending logins
 * and re-reads `latestSession`. If the token changed, it retries the
 * query with the new one. If the token hasn't changed, the empty is
 * passed through — callers that want to force a fresh login as a
 * recovery can trigger `nvrClient.refreshSessionNow()` before retrying.
 */
export async function queryChlRecLogFresh(
  channelId: string,
  startTimeStr: string,
  endTimeStr: string,
): Promise<RecordingSegment[]> {
  await nvrClient.awaitPendingLogins();
  const s1 = nvrClient.latestSession;
  if (!s1) throw new Error("queryChlRecLogFresh: no session available");
  let segments = await queryChlRecLog(
    s1.host,
    s1.token,
    s1.sessionId,
    channelId,
    startTimeStr,
    endTimeStr,
  );
  if (segments.length === 0) {
    await nvrClient.awaitPendingLogins();
    const s2 = nvrClient.latestSession;
    if (s2 && s2.token !== s1.token) {
      console.log(
        `[query-helpers] queryChlRecLog ch=${channelId.slice(1, 9)} empty on s1=${s1.sessionId.slice(0, 8)} — retrying on fresh s2=${s2.sessionId.slice(0, 8)}`,
      );
      segments = await queryChlRecLog(
        s2.host,
        s2.token,
        s2.sessionId,
        channelId,
        startTimeStr,
        endTimeStr,
      );
    }
  }
  return segments;
}

/**
 * Same fresh-token retry pattern as queryChlRecLogFresh, but for
 * queryDatesExistRec (date-picker population). Silent-empty here means
 * the date picker would show no selectable dates even when recordings
 * exist — a confusing dead-end for the user.
 */
export async function queryDatesExistRecFresh(
  channelId: string,
): Promise<{ dates: string[]; startTime: string; endTime: string; duration: number }> {
  await nvrClient.awaitPendingLogins();
  const s1 = nvrClient.latestSession;
  if (!s1) throw new Error("queryDatesExistRecFresh: no session available");
  let info = await queryDatesExistRec(s1.host, s1.token, s1.sessionId, channelId);
  if (info.dates.length === 0) {
    await nvrClient.awaitPendingLogins();
    const s2 = nvrClient.latestSession;
    if (s2 && s2.token !== s1.token) {
      console.log(
        `[query-helpers] queryDatesExistRec ch=${channelId.slice(1, 9)} empty on s1=${s1.sessionId.slice(0, 8)} — retrying on fresh s2=${s2.sessionId.slice(0, 8)}`,
      );
      info = await queryDatesExistRec(s2.host, s2.token, s2.sessionId, channelId);
    }
  }
  return info;
}
