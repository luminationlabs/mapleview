import { describe, expect, it } from "vitest";
import { generateTaskId } from "../guid";

describe("generateTaskId", () => {
  it("returns a brace-wrapped UUID", () => {
    const id = generateTaskId();
    expect(id.startsWith("{")).toBe(true);
    expect(id.endsWith("}")).toBe(true);
  });

  it("contains a valid UUID v4 pattern", () => {
    const id = generateTaskId();
    // Strip braces
    const uuid = id.slice(1, -1);
    // UUID v4 format: 8-4-4-4-12 hex chars, uppercase
    const uuidV4Pattern =
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;
    expect(uuid).toMatch(uuidV4Pattern);
  });

  it("is uppercase", () => {
    const id = generateTaskId();
    const uuid = id.slice(1, -1);
    expect(uuid).toBe(uuid.toUpperCase());
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTaskId()));
    expect(ids.size).toBe(100);
  });
});
