import { describe, it, expect } from "vitest";
import {
  localTimeToUnix,
  unixToLocalTimeStr,
  unixToDisplayTime,
  dayToUnixRange,
  projectTimeOntoDay,
  snapToNearestRange,
} from "../time";

describe("localTimeToUnix", () => {
  it("converts a local time string to Unix seconds", () => {
    const unix = localTimeToUnix("2026-01-01 00:00:00");
    // Verify round-trip: the Date at that unix should be midnight local Jan 1
    const d = new Date(unix * 1000);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it("throws on invalid input", () => {
    expect(() => localTimeToUnix("not-a-date")).toThrow("Invalid local time");
  });
});

describe("unixToLocalTimeStr", () => {
  it("formats with :000 millisecond suffix", () => {
    const unix = localTimeToUnix("2026-04-13 21:07:57");
    const str = unixToLocalTimeStr(unix);
    expect(str).toBe("2026-04-13 21:07:57:000");
  });

  it("pads single-digit months and days", () => {
    const unix = localTimeToUnix("2026-01-05 03:02:01");
    const str = unixToLocalTimeStr(unix);
    expect(str).toBe("2026-01-05 03:02:01:000");
  });
});

describe("unixToDisplayTime", () => {
  it("formats afternoon time with PM", () => {
    const unix = localTimeToUnix("2026-04-13 15:07:57");
    expect(unixToDisplayTime(unix)).toBe("3:07:57 PM");
  });

  it("formats midnight as 12:00:00 AM", () => {
    const unix = localTimeToUnix("2026-04-13 00:00:00");
    expect(unixToDisplayTime(unix)).toBe("12:00:00 AM");
  });

  it("formats noon as 12:00:00 PM", () => {
    const unix = localTimeToUnix("2026-04-13 12:00:00");
    expect(unixToDisplayTime(unix)).toBe("12:00:00 PM");
  });
});

describe("dayToUnixRange", () => {
  it("returns start and end for a day", () => {
    const range = dayToUnixRange("2026-04-13");
    const startDate = new Date(range.start * 1000);
    const endDate = new Date(range.end * 1000);

    expect(startDate.getHours()).toBe(0);
    expect(startDate.getMinutes()).toBe(0);
    expect(startDate.getSeconds()).toBe(0);

    expect(endDate.getHours()).toBe(23);
    expect(endDate.getMinutes()).toBe(59);
    expect(endDate.getSeconds()).toBe(59);
  });

  it("throws on invalid date", () => {
    expect(() => dayToUnixRange("bad")).toThrow("Invalid date string");
  });
});

describe("projectTimeOntoDay", () => {
  it("preserves hh:mm:ss when switching to an earlier day", () => {
    // 14:32:05 on day N should become 14:32:05 on day N-1.
    const from = localTimeToUnix("2026-04-18 14:32:05");
    const projected = projectTimeOntoDay(from, "2026-04-18", "2026-04-17");
    const { start: day17Start } = dayToUnixRange("2026-04-17");
    expect(projected - day17Start).toBe(
      14 * 3600 + 32 * 60 + 5,
    );
  });

  it("preserves hh:mm:ss when switching to a later day", () => {
    const from = localTimeToUnix("2026-04-17 09:15:00");
    const projected = projectTimeOntoDay(from, "2026-04-17", "2026-04-18");
    const { start: day18Start } = dayToUnixRange("2026-04-18");
    expect(projected - day18Start).toBe(9 * 3600 + 15 * 60);
  });

  it("returns new day's start if the input is not on fromDate (defensive)", () => {
    const from = localTimeToUnix("2026-04-17 00:00:00");
    const projected = projectTimeOntoDay(from, "2026-04-18", "2026-04-19");
    expect(projected).toBe(dayToUnixRange("2026-04-19").start);
  });

  it("handles switching to the same day as a no-op", () => {
    const from = localTimeToUnix("2026-04-18 22:45:30");
    const projected = projectTimeOntoDay(from, "2026-04-18", "2026-04-18");
    expect(projected).toBe(from);
  });
});

describe("snapToNearestRange", () => {
  it("returns null for empty ranges", () => {
    expect(snapToNearestRange([], 100)).toBeNull();
  });

  it("returns preferred unchanged when it falls inside a range", () => {
    const ranges = [
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ];
    expect(snapToNearestRange(ranges, 150)).toBe(150);
    expect(snapToNearestRange(ranges, 100)).toBe(100); // inclusive start
    expect(snapToNearestRange(ranges, 400)).toBe(400); // inclusive end
  });

  it("snaps to the nearest range edge in a gap", () => {
    const ranges = [
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ];
    // preferred 210: 10 past first-end, 90 before second-start → first-end.
    expect(snapToNearestRange(ranges, 210)).toBe(200);
    // preferred 290: 90 past first-end, 10 before second-start → second-start.
    expect(snapToNearestRange(ranges, 290)).toBe(300);
    // preferred 250: exactly midway → whichever we see first is fine.
    const midResult = snapToNearestRange(ranges, 250);
    expect(midResult === 200 || midResult === 300).toBe(true);
  });

  it("snaps to first range start when preferred is before all ranges", () => {
    const ranges = [
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ];
    expect(snapToNearestRange(ranges, 50)).toBe(100);
  });

  it("snaps to last range end when preferred is after all ranges", () => {
    const ranges = [
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ];
    expect(snapToNearestRange(ranges, 500)).toBe(400);
  });

  it("handles unsorted ranges correctly", () => {
    const ranges = [
      { start: 300, end: 400 },
      { start: 100, end: 200 },
    ];
    expect(snapToNearestRange(ranges, 150)).toBe(150);
    expect(snapToNearestRange(ranges, 50)).toBe(100);
  });

  it("handles a single range", () => {
    const ranges = [{ start: 100, end: 200 }];
    expect(snapToNearestRange(ranges, 50)).toBe(100);
    expect(snapToNearestRange(ranges, 150)).toBe(150);
    expect(snapToNearestRange(ranges, 250)).toBe(200);
  });
});
