import * as SecureStore from 'expo-secure-store';
import type { NvrSession } from '../nvr/types';

const KEY_HOST = 'nvr_host';
const KEY_USERNAME = 'nvr_username';
const KEY_PASSWORD = 'nvr_password';
const KEY_SESSION = 'nvr_session';

/**
 * Persisted session — last known valid {sessionId, token} after a
 * successful login. Used by nvrClient.connect() to skip the full login
 * round-trip when the NVR still accepts the cached session (probed via
 * a cheap enumerateCameras call). On probe failure, the cache is
 * deleted and we fall through to fresh login.
 *
 * Stored with a timestamp so very-stale caches can be discarded up-
 * front without a round-trip. The session itself is tied to the host
 * and user — changing either invalidates the cache.
 */
interface CachedSession {
  host: string;
  userName: string;
  session: NvrSession;
  savedAt: number;
}

/**
 * Max cache age before we bypass the probe and force a fresh login.
 * Short enough that even if the NVR garbage-collects idle sessions
 * after some cap, we're unlikely to waste the probe — long enough to
 * cover typical "close app, reopen later the same day" reuse windows.
 */
const SESSION_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h

export async function saveCachedSession(
  host: string,
  userName: string,
  session: NvrSession,
): Promise<void> {
  const payload: CachedSession = {
    host,
    userName,
    session,
    savedAt: Date.now(),
  };
  try {
    await SecureStore.setItemAsync(KEY_SESSION, JSON.stringify(payload));
  } catch {
    // Best-effort — cache miss just means we'll re-login next launch.
  }
}

export async function loadCachedSession(
  host: string,
  userName: string,
): Promise<NvrSession | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(KEY_SESSION);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: CachedSession;
  try {
    parsed = JSON.parse(raw) as CachedSession;
  } catch {
    return null;
  }
  // Bind the cache to host + user: if either changes (NVR IP change,
  // user switched accounts), the cached session isn't ours to reuse.
  if (parsed.host !== host || parsed.userName !== userName) return null;
  if (Date.now() - parsed.savedAt > SESSION_CACHE_MAX_AGE_MS) return null;
  return parsed.session;
}

export async function clearCachedSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY_SESSION);
  } catch {
    // best-effort
  }
}

export async function saveCredentials(
  host: string,
  username: string,
  password: string,
): Promise<void> {
  await SecureStore.setItemAsync(KEY_HOST, host);
  await SecureStore.setItemAsync(KEY_USERNAME, username);
  await SecureStore.setItemAsync(KEY_PASSWORD, password);
}

export async function loadCredentials(): Promise<{
  host: string;
  username: string;
  password: string;
} | null> {
  const host = await SecureStore.getItemAsync(KEY_HOST);
  const username = await SecureStore.getItemAsync(KEY_USERNAME);
  const password = await SecureStore.getItemAsync(KEY_PASSWORD);

  if (!host || !username || !password) {
    return null;
  }

  return { host, username, password };
}

/**
 * Clear stored username and password. The host is intentionally preserved so
 * the next onboarding pass can pre-fill it — most users only ever point the
 * app at one NVR, and retyping the address (especially an IP + port) is a
 * worse experience than the slight data-hygiene cost of leaving it behind.
 */
export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_USERNAME);
  await SecureStore.deleteItemAsync(KEY_PASSWORD);
}

export async function loadHost(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_HOST);
}
