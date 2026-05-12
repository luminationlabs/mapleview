import { useCallback } from "react";
import { useUIStore } from "../store/ui-store";
import { restorePurchases } from "../services/iap";

export function useIsPro(): boolean {
  return useUIStore((s) => s.isPro);
}

export function usePaywall(): {
  showPaywall: () => void;
  hidePaywall: () => void;
} {
  const setPaywallOpen = useUIStore((s) => s.setPaywallOpen);
  const showPaywall = useCallback(() => setPaywallOpen(true), [setPaywallOpen]);
  const hidePaywall = useCallback(
    () => setPaywallOpen(false),
    [setPaywallOpen],
  );
  return { showPaywall, hidePaywall };
}

export function useRestorePurchases(): () => Promise<void> {
  return useCallback(async () => {
    await restorePurchases();
  }, []);
}
