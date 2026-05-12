/**
 * Parse a host input string. Plain HTTP is the default; an explicit
 * `https://` prefix is preserved so the rest of the app uses HTTPS/WSS.
 *
 * Accepts:
 *   - "192.168.1.100"               -> "192.168.1.100"
 *   - "192.168.1.100:8080"          -> "192.168.1.100:8080"
 *   - "http://192.168.1.100"        -> "192.168.1.100"
 *   - "http://192.168.1.100:8080/"  -> "192.168.1.100:8080"
 *   - "https://nvr.example.com"     -> "https://nvr.example.com"
 *   - "https://nvr.example.com/x"   -> "https://nvr.example.com"
 *
 * The returned string is what gets stored and threaded through the app.
 * Use `httpUrl()` / `wsUrl()` from this module to build request URLs;
 * they pick http/https and ws/wss from the prefix.
 */
export function parseHost(input: string): string {
  let trimmed = input.trim();

  // Schemes are case-insensitive (RFC 3986); pasted URLs sometimes carry
  // unexpected casing. Only the scheme prefix is lowercased — the host
  // itself is left alone so we don't disturb anything downstream.
  let secure = false;
  const lowerPrefix = trimmed.slice(0, 8).toLowerCase();
  if (lowerPrefix.startsWith("https://")) {
    secure = true;
    trimmed = trimmed.slice(8);
  } else if (lowerPrefix.startsWith("http://")) {
    trimmed = trimmed.slice(7);
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex !== -1) {
    trimmed = trimmed.slice(0, slashIndex);
  }

  return secure ? `https://${trimmed}` : trimmed;
}

function isSecure(host: string): boolean {
  return host.startsWith("https://");
}

function bareHost(host: string): string {
  return isSecure(host) ? host.slice(8) : host;
}

/**
 * Build an HTTP(S) URL for a given host + path. Path must start with `/`.
 */
export function httpUrl(host: string, path: string): string {
  const scheme = isSecure(host) ? "https" : "http";
  return `${scheme}://${bareHost(host)}${path}`;
}

/**
 * Build a WebSocket URL for a given host + path. Path must start with `/`.
 */
export function wsUrl(host: string, path: string): string {
  const scheme = isSecure(host) ? "wss" : "ws";
  return `${scheme}://${bareHost(host)}${path}`;
}

/**
 * Origin string for a Referer header (`scheme://host/`).
 */
export function originUrl(host: string): string {
  return httpUrl(host, "/");
}
