import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock storage before importing the store
vi.mock("../kv-storage", () => ({
  kvStorage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocking
const { useUIStore } = await import("../ui-store");

describe("useUIStore", () => {
  beforeEach(() => {
    // Reset to defaults
    useUIStore.setState({ gridLayout: 4, viewMode: "grid" });
  });

  it("starts with default grid layout of 4", () => {
    expect(useUIStore.getState().gridLayout).toBe(4);
  });

  it("starts with default view mode of grid", () => {
    expect(useUIStore.getState().viewMode).toBe("grid");
  });

  it("setGridLayout updates the layout", () => {
    useUIStore.getState().setGridLayout(9);
    expect(useUIStore.getState().gridLayout).toBe(9);
  });

  it("setGridLayout accepts all valid values", () => {
    for (const layout of [1, 4, 6, 9, 12, 16] as const) {
      useUIStore.getState().setGridLayout(layout);
      expect(useUIStore.getState().gridLayout).toBe(layout);
    }
  });

  it("setViewMode switches between grid and list", () => {
    useUIStore.getState().setViewMode("list");
    expect(useUIStore.getState().viewMode).toBe("list");

    useUIStore.getState().setViewMode("grid");
    expect(useUIStore.getState().viewMode).toBe("grid");
  });
});
