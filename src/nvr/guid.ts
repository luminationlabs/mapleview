/**
 * Generate a brace-wrapped uppercase UUID v4.
 *
 * Uses crypto.randomUUID() when available (Hermes), otherwise falls back
 * to a Math.random()-based implementation.
 */
export function generateTaskId(): string {
  let uuid: string;

  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    uuid = globalThis.crypto.randomUUID();
  } else {
    // Fallback: Math.random-based v4 UUID
    uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );
  }

  return `{${uuid.toUpperCase()}}`;
}
