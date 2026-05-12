import { describe, it, expect } from "vitest";
import { md5Hex, sha512Hex, computePasswordHash } from "../crypto";

describe("md5Hex", () => {
  it("should compute correct MD5 hex digest", () => {
    // Well-known MD5 test vector
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("should return 32-character hex string", () => {
    const result = md5Hex("test");
    expect(result).toHaveLength(32);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("sha512Hex", () => {
  it("should compute correct SHA-512 hex digest", () => {
    const result = sha512Hex("abc");
    expect(result).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("should return 128-character hex string", () => {
    const result = sha512Hex("test");
    expect(result).toHaveLength(128);
    expect(result).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe("computePasswordHash", () => {
  it("should produce 128-char hex output", () => {
    const result = computePasswordHash(
      "myPassword",
      "{F67500CA-19EC-4B63-8B3E-4E53A0C15914}",
    );
    expect(result).toHaveLength(128);
    expect(result).toMatch(/^[0-9a-f]{128}$/);
  });

  it("should follow the formula: SHA512(UPPER(MD5(password)) + '#' + nonce)", () => {
    const password = "testpass";
    const nonce = "{ABCDEF00-1234-5678-9ABC-DEF012345678}";

    // SparkMD5.hash() returns uppercase hex, so the formula uses uppercase MD5
    const md5OfPass = md5Hex(password).toUpperCase();
    const expected = sha512Hex(`${md5OfPass}#${nonce}`);
    const result = computePasswordHash(password, nonce);

    expect(result).toBe(expected);
  });

  it("should produce different hashes for different nonces", () => {
    const password = "same";
    const hash1 = computePasswordHash(password, "{NONCE-1}");
    const hash2 = computePasswordHash(password, "{NONCE-2}");
    expect(hash1).not.toBe(hash2);
  });

  it("should produce different hashes for different passwords", () => {
    const nonce = "{SAME-NONCE}";
    const hash1 = computePasswordHash("pass1", nonce);
    const hash2 = computePasswordHash("pass2", nonce);
    expect(hash1).not.toBe(hash2);
  });
});
