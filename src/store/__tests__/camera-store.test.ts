import { beforeEach, describe, expect, it } from "vitest";
import { cameraStore } from "../camera-store";
import type { CameraInfo } from "../../nvr/types";

describe("cameraStore", () => {
  const cameras: CameraInfo[] = [
    { channelId: "{CAM-1}", name: "Front Door", status: "online" },
    { channelId: "{CAM-2}", name: "Backyard", status: "online" },
    { channelId: "{CAM-3}", name: "Garage", status: "offline" },
  ];

  beforeEach(() => {
    cameraStore.getState().clear();
  });

  it("starts with empty cameras list", () => {
    expect(cameraStore.getState().cameras).toEqual([]);
  });

  it("setCameras replaces the list", () => {
    cameraStore.getState().setCameras(cameras);
    expect(cameraStore.getState().cameras).toHaveLength(3);
    expect(cameraStore.getState().cameras[0].name).toBe("Front Door");
  });

  it("updateStatus changes status for matching channel", () => {
    cameraStore.getState().setCameras(cameras);
    cameraStore.getState().updateStatus("{CAM-2}", "failed");

    const updated = cameraStore.getState().cameras;
    expect(updated[1].status).toBe("failed");
    // Others unchanged
    expect(updated[0].status).toBe("online");
    expect(updated[2].status).toBe("offline");
  });

  it("updateStatus with unknown channelId is a no-op", () => {
    cameraStore.getState().setCameras(cameras);
    cameraStore.getState().updateStatus("{UNKNOWN}", "failed");

    expect(cameraStore.getState().cameras).toEqual(cameras);
  });

  it("reorder moves item from one index to another", () => {
    cameraStore.getState().setCameras(cameras);
    cameraStore.getState().reorder(0, 2);

    const reordered = cameraStore.getState().cameras;
    expect(reordered[0].name).toBe("Backyard");
    expect(reordered[1].name).toBe("Garage");
    expect(reordered[2].name).toBe("Front Door");
  });

  it("reorder with out-of-bounds indices is a no-op", () => {
    cameraStore.getState().setCameras(cameras);
    cameraStore.getState().reorder(-1, 5);

    expect(cameraStore.getState().cameras).toEqual(cameras);
  });

  it("clear empties the list", () => {
    cameraStore.getState().setCameras(cameras);
    cameraStore.getState().clear();
    expect(cameraStore.getState().cameras).toEqual([]);
  });
});
