import { computePasswordHash } from "./crypto";
import type { NvrSession, ReqLoginResponse } from "./types";
import { buildRequestXml, parseResponseXml } from "./xml";
import { httpUrl, originUrl } from "../utils/parse-host";

/**
 * Perform an HTTP POST using XMLHttpRequest, which reliably supports
 * manual Cookie headers in React Native (unlike fetch, which may strip them).
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

/**
 * Strip braces from a GUID string.
 * "{7A5D5717-A202-457A-B70C-D523B18D4F93}" -> "7A5D5717-A202-457A-B70C-D523B18D4F93"
 */
export function stripBraces(guid: string): string {
  if (guid.startsWith("{") && guid.endsWith("}")) {
    return guid.slice(1, -1);
  }
  return guid;
}

/**
 * Perform the two-step NVR login flow.
 *
 * Step 1: POST /reqLogin (no credentials) -> get sessionId, nonce, token
 * Step 2: POST /doLogin with hashed password -> get userId, session established
 *
 * @param host - NVR hostname or IP (e.g. "192.168.1.100")
 * @param userName - Username (e.g. "admin")
 * @param password - Plaintext password
 * @returns NvrSession with session details needed for subsequent requests
 */
export async function login(
  host: string,
  userName: string,
  password: string,
): Promise<NvrSession> {
  // Step 1: reqLogin
  const reqLoginBody = buildRequestXml("null");
  const reqLoginResp = await fetch(httpUrl(host, "/reqLogin"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: originUrl(host),
    },
    body: reqLoginBody,
  });

  if (!reqLoginResp.ok) {
    throw new Error(`reqLogin failed: HTTP ${reqLoginResp.status}`);
  }

  const reqLoginXml = await reqLoginResp.text();
  const reqLoginParsed = parseResponseXml(reqLoginXml);

  if (reqLoginParsed.status !== "success") {
    throw new Error(`reqLogin failed: status=${reqLoginParsed.status}`);
  }

  const content = reqLoginParsed.content as unknown as ReqLoginResponse;
  const sessionIdBraced = String(content.sessionId);
  const nonce = String(content.nonce); // keep braces
  const token = String(content.token);

  // Strip braces from sessionId for cookie use
  const sessionId = stripBraces(sessionIdBraced);

  // Step 2: Compute password hash
  const passwordHash = computePasswordHash(password, nonce);

  // Step 3: doLogin
  // Use XMLHttpRequest instead of fetch because React Native's fetch
  // may strip manually-set Cookie headers on iOS.
  const doLoginContent =
    `<userName><![CDATA[${userName}]]></userName>` +
    `<password><![CDATA[${passwordHash}]]></password>`;
  const doLoginBody = buildRequestXml(token, doLoginContent);

  const doLoginXml = await xhrPost(httpUrl(host, "/doLogin"), {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Referer: originUrl(host),
    Cookie: `sessionId=${sessionId}`,
  }, doLoginBody);

  const doLoginParsed = parseResponseXml(doLoginXml);

  if (doLoginParsed.status !== "success") {
    // Surface the actual NVR error message if available
    const dlContent = doLoginParsed.content as Record<string, unknown>;
    const nvrMsg = dlContent?.errorDescription ?? dlContent?.msg ?? "";
    throw new Error(
      nvrMsg ? `doLogin: ${nvrMsg}` : `doLogin failed: status=${doLoginParsed.status}`,
    );
  }

  const loginContent = doLoginParsed.content as Record<string, unknown>;
  const userId = String(loginContent.userId ?? "");

  return {
    host,
    sessionId, // bare UUID from reqLogin (this is the one used for all subsequent calls)
    token,
    userId,
    userName,
  };
}
