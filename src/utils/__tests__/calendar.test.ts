import { describe, it, expect } from "vitest";
import { buildCalendarGrid, fmtYMD, parseYMD, todayStr } from "../calendar";

describe("parseYMD", () => {
  it("parses a YYYY-MM-DD string", () => {
    expect(parseYMD("2026-04-13")).toEqual({ year: 2026, month: 3, day: 13 });
  });

  it("parses January correctly (month 0-based)", () => {
    expect(parseYMD("2025-01-01")).toEqual({ year: 2025, month: 0, day: 1 });
  });

  it("parses December correctly", () => {
    expect(parseYMD("2025-12-31")).toEqual({ year: 2025, month: 11, day: 31 });
  });
});

describe("fmtYMD", () => {
  it("formats year, 0-based month, day into YYYY-MM-DD", () => {
    expect(fmtYMD(2026, 3, 13)).toBe("2026-04-13");
  });

  it("zero-pads month and day", () => {
    expect(fmtYMD(2025, 0, 5)).toBe("2025-01-05");
  });
});

describe("todayStr", () => {
  it("returns a string matching YYYY-MM-DD format", () => {
    const result = todayStr();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("buildCalendarGrid", () => {
  it("returns correct number of rows for April 2026", () => {
    // April 2026: starts on Wednesday (index 3), 30 days
    // 3 blanks + 30 days = 33 cells -> ceil(33/7) = 5 rows
    const rows = buildCalendarGrid(2026, 3); // month is 0-based
    expect(rows.length).toBe(5);
    expect(rows[0].length).toBe(7);
  });

  it("has leading nulls before the first day", () => {
    // April 2026 starts on Wednesday = index 3
    const rows = buildCalendarGrid(2026, 3);
    expect(rows[0][0]).toBeNull();
    expect(rows[0][1]).toBeNull();
    expect(rows[0][2]).toBeNull();
    expect(rows[0][3]).not.toBeNull();
    expect(rows[0][3]!.day).toBe(1);
    expect(rows[0][3]!.dateStr).toBe("2026-04-01");
  });

  it("has 30 day cells for April", () => {
    const rows = buildCalendarGrid(2026, 3);
    const allCells = rows.flat();
    const dayCells = allCells.filter((c) => c !== null);
    expect(dayCells.length).toBe(30);
  });

  it("has 31 day cells for January", () => {
    const rows = buildCalendarGrid(2026, 0);
    const allCells = rows.flat();
    const dayCells = allCells.filter((c) => c !== null);
    expect(dayCells.length).toBe(31);
  });

  it("handles February in a leap year", () => {
    // 2024 is a leap year
    const rows = buildCalendarGrid(2024, 1);
    const allCells = rows.flat();
    const dayCells = allCells.filter((c) => c !== null);
    expect(dayCells.length).toBe(29);
  });

  it("handles February in a non-leap year", () => {
    const rows = buildCalendarGrid(2025, 1);
    const allCells = rows.flat();
    const dayCells = allCells.filter((c) => c !== null);
    expect(dayCells.length).toBe(28);
  });

  it("last day has correct dateStr", () => {
    const rows = buildCalendarGrid(2026, 3); // April 2026
    const allCells = rows.flat();
    const dayCells = allCells.filter((c) => c !== null);
    const lastDay = dayCells[dayCells.length - 1]!;
    expect(lastDay.day).toBe(30);
    expect(lastDay.dateStr).toBe("2026-04-30");
  });

  it("all rows have exactly 7 cells", () => {
    const rows = buildCalendarGrid(2026, 3);
    for (const row of rows) {
      expect(row.length).toBe(7);
    }
  });

  it("month starting on Sunday has no leading nulls", () => {
    // March 2026 starts on Sunday
    const rows = buildCalendarGrid(2026, 2);
    expect(rows[0][0]).not.toBeNull();
    expect(rows[0][0]!.day).toBe(1);
  });
});
