import { beforeEach, describe, expect, it } from "vitest";
import { playbackStore, mergeTimeRanges } from "../playback-store";
import type { RecordingSegment } from "../../nvr/types";

describe("mergeTimeRanges", () => {
  it("returns empty array for empty input", () => {
    expect(mergeTimeRanges([])).toEqual([]);
  });

  it("returns single range unchanged", () => {
    expect(mergeTimeRanges([{ start: 100, end: 200 }])).toEqual([
      { start: 100, end: 200 },
    ]);
  });

  it("merges overlapping ranges", () => {
    const result = mergeTimeRanges([
      { start: 100, end: 300 },
      { start: 200, end: 400 },
    ]);
    expect(result).toEqual([{ start: 100, end: 400 }]);
  });

  it("merges adjacent ranges (touching at boundary)", () => {
    const result = mergeTimeRanges([
      { start: 100, end: 200 },
      { start: 200, end: 300 },
    ]);
    expect(result).toEqual([{ start: 100, end: 300 }]);
  });

  it("keeps non-overlapping ranges separate", () => {
    const result = mergeTimeRanges([
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ]);
    expect(result).toEqual([
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ]);
  });

  it("handles unsorted input", () => {
    const result = mergeTimeRanges([
      { start: 300, end: 400 },
      { start: 100, end: 250 },
      { start: 200, end: 350 },
    ]);
    expect(result).toEqual([{ start: 100, end: 400 }]);
  });

  it("does not mutate input", () => {
    const input = [
      { start: 300, end: 400 },
      { start: 100, end: 200 },
    ];
    mergeTimeRanges(input);
    expect(input[0].start).toBe(300); // not sorted in place
  });
});

describe("playbackStore", () => {
  beforeEach(() => {
    playbackStore.getState().clearSegments();
    playbackStore.setState({
      currentTime: 0,
      isPlaying: false,
      speed: 1,
      loadingSegments: false,
    });
  });

  it("has sensible defaults", () => {
    const state = playbackStore.getState();
    expect(state.currentTime).toBe(0);
    expect(state.isPlaying).toBe(false);
    expect(state.speed).toBe(1);
    expect(state.selectedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.cameraSegments).toEqual({});
    expect(state.compositeSegments).toEqual([]);
    expect(state.loadingSegments).toBe(false);
  });

  it("setCurrentTime updates currentTime", () => {
    playbackStore.getState().setCurrentTime(12345);
    expect(playbackStore.getState().currentTime).toBe(12345);
  });

  it("setPlaying toggles isPlaying", () => {
    playbackStore.getState().setPlaying(true);
    expect(playbackStore.getState().isPlaying).toBe(true);
    playbackStore.getState().setPlaying(false);
    expect(playbackStore.getState().isPlaying).toBe(false);
  });

  it("setSpeed updates speed", () => {
    playbackStore.getState().setSpeed(4);
    expect(playbackStore.getState().speed).toBe(4);
  });

  it("setSelectedDate updates selectedDate", () => {
    playbackStore.getState().setSelectedDate("2026-01-15");
    expect(playbackStore.getState().selectedDate).toBe("2026-01-15");
  });

  it("setCameraSegments stores segments per channel", () => {
    const segments: RecordingSegment[] = [
      { recType: "MOTION", startTime: "2026-04-13 10:00:00", endTime: "2026-04-13 10:30:00", size: 50 },
    ];
    playbackStore.getState().setCameraSegments("ch1", segments);
    expect(playbackStore.getState().cameraSegments["ch1"]).toEqual(segments);
  });

  it("setCameraSegments preserves other channels", () => {
    const seg1: RecordingSegment[] = [
      { recType: "MOTION", startTime: "2026-04-13 10:00:00", endTime: "2026-04-13 10:30:00", size: 50 },
    ];
    const seg2: RecordingSegment[] = [
      { recType: "SCHEDULE", startTime: "2026-04-13 11:00:00", endTime: "2026-04-13 11:30:00", size: 60 },
    ];
    playbackStore.getState().setCameraSegments("ch1", seg1);
    playbackStore.getState().setCameraSegments("ch2", seg2);
    expect(playbackStore.getState().cameraSegments["ch1"]).toEqual(seg1);
    expect(playbackStore.getState().cameraSegments["ch2"]).toEqual(seg2);
  });

  it("clearSegments resets cameraSegments and compositeSegments", () => {
    playbackStore.getState().setCameraSegments("ch1", [
      { recType: "MOTION", startTime: "2026-04-13 10:00:00", endTime: "2026-04-13 10:30:00", size: 50 },
    ]);
    playbackStore.getState().clearSegments();
    expect(playbackStore.getState().cameraSegments).toEqual({});
    expect(playbackStore.getState().compositeSegments).toEqual([]);
  });

  it("setLoadingSegments updates loading flag", () => {
    playbackStore.getState().setLoadingSegments(true);
    expect(playbackStore.getState().loadingSegments).toBe(true);
  });

  it("computeCompositeSegments merges visible channel segments", () => {
    // Two channels with overlapping segments
    playbackStore.getState().setCameraSegments("ch1", [
      { recType: "MOTION", startTime: "2026-01-01 10:00:00", endTime: "2026-01-01 10:30:00", size: 50 },
    ]);
    playbackStore.getState().setCameraSegments("ch2", [
      { recType: "SCHEDULE", startTime: "2026-01-01 10:15:00", endTime: "2026-01-01 11:00:00", size: 60 },
    ]);

    playbackStore.getState().computeCompositeSegments(["ch1", "ch2"]);

    const composite = playbackStore.getState().compositeSegments;
    expect(composite).toHaveLength(1);
    // Should be merged: 10:00 to 11:00 (times are stored as UTC).
    const d1 = new Date(composite[0].start * 1000);
    const d2 = new Date(composite[0].end * 1000);
    expect(d1.getUTCHours()).toBe(10);
    expect(d1.getUTCMinutes()).toBe(0);
    expect(d2.getUTCHours()).toBe(11);
    expect(d2.getUTCMinutes()).toBe(0);
  });

  it("computeCompositeSegments ignores channels not in visible list", () => {
    playbackStore.getState().setCameraSegments("ch1", [
      { recType: "MOTION", startTime: "2026-01-01 10:00:00", endTime: "2026-01-01 10:30:00", size: 50 },
    ]);
    playbackStore.getState().setCameraSegments("ch2", [
      { recType: "SCHEDULE", startTime: "2026-01-01 14:00:00", endTime: "2026-01-01 15:00:00", size: 60 },
    ]);

    // Only ch1 is visible
    playbackStore.getState().computeCompositeSegments(["ch1"]);
    expect(playbackStore.getState().compositeSegments).toHaveLength(1);
  });

  it("computeCompositeSegments handles empty visible list", () => {
    playbackStore.getState().setCameraSegments("ch1", [
      { recType: "MOTION", startTime: "2026-01-01 10:00:00", endTime: "2026-01-01 10:30:00", size: 50 },
    ]);
    playbackStore.getState().computeCompositeSegments([]);
    expect(playbackStore.getState().compositeSegments).toEqual([]);
  });
});
