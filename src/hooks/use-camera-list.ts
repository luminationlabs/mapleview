import { useCameraStore } from "../store/camera-store";

/**
 * Hook that returns the camera list and reorder function.
 */
export function useCameraList() {
  const cameras = useCameraStore((s) => s.cameras);
  const reorder = useCameraStore((s) => s.reorder);

  return { cameras, reorder };
}
