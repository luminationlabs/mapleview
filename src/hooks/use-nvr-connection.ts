import { useEffect } from "react";
import { nvrClient } from "../nvr/client";
import { useSessionStore } from "../store/session-store";

/**
 * Hook that connects to an NVR on mount and exposes connection state.
 */
export function useNvrConnection(
  host: string,
  userName: string,
  password: string,
) {
  const connected = useSessionStore((s) => s.connected);
  const connecting = useSessionStore((s) => s.connecting);
  const error = useSessionStore((s) => s.error);

  useEffect(() => {
    nvrClient.connect(host, userName, password).catch(() => {
      // error is already set in the store by connect()
    });
    return () => {
      nvrClient.disconnect();
    };
  }, [host, userName, password]);

  return { connected, connecting, error };
}
