import { md5 } from "js-md5";
import { sha512 } from "js-sha512";

/**
 * Compute the MD5 hex digest of a string.
 */
export function md5Hex(input: string): string {
  return md5(input);
}

/**
 * Compute the SHA-512 hex digest of a string.
 */
export function sha512Hex(input: string): string {
  return sha512(input);
}

/**
 * Compute the NVR password hash for the doLogin step.
 *
 * Formula: SHA512_hex( MD5_hex(plainPassword) + "#" + nonceWithBraces )
 *
 * @param plainPassword - The user's plaintext password
 * @param nonce - The nonce from reqLogin, WITH braces (e.g. "{UUID}")
 * @returns 128-character hex string (SHA-512 output)
 */
export function computePasswordHash(
  plainPassword: string,
  nonce: string,
): string {
  const md5OfPassword = md5Hex(plainPassword).toUpperCase();
  return sha512Hex(`${md5OfPassword}#${nonce}`);
}
