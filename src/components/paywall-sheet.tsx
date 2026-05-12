import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useUIStore } from "../store/ui-store";
import {
  getProduct,
  purchasePro,
  restorePurchases,
  type PurchaseStatus,
} from "../services/iap";

const ACCENT = "#0A84FF";

// Non-breaking hyphen (‑) and non-breaking space ( ) keep tight
// phrases like "16-up" and "grid size" from wrapping awkwardly mid-pair.
const FEATURES = [
  "View all your cameras in 6, 9, 12, or 16‑up grids",
  "Live and recorded playback at every grid size",
  "One‑time purchase — yours forever",
];

export function PaywallSheet() {
  const visible = useUIStore((s) => s.paywallOpen);
  const setPaywallOpen = useUIStore((s) => s.setPaywallOpen);
  const isPro = useUIStore((s) => s.isPro);

  const [price, setPrice] = useState<string | null>(null);
  const [productUnavailable, setProductUnavailable] = useState(false);
  const [busy, setBusy] = useState<"idle" | "buying" | "restoring">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setErrorMsg(null);
    setProductUnavailable(false);
    getProduct()
      .then((p) => {
        if (p) {
          setPrice(p.displayPrice);
          setProductUnavailable(false);
        } else {
          setPrice(null);
          setProductUnavailable(true);
        }
      })
      .catch(() => {
        setPrice(null);
        setProductUnavailable(true);
      });
  }, [visible]);

  // Auto-dismiss once entitlement flips on.
  useEffect(() => {
    if (visible && isPro) setPaywallOpen(false);
  }, [visible, isPro, setPaywallOpen]);

  const close = useCallback(() => setPaywallOpen(false), [setPaywallOpen]);
  // Don't allow the user to dismiss the sheet (overlay tap, Android back)
  // while a purchase or restore is in flight — they'd lose the
  // confirmation and not know whether it succeeded.
  const guardedClose = useCallback(() => {
    if (busy === "idle") close();
  }, [busy, close]);

  const handleBuy = useCallback(async () => {
    setErrorMsg(null);
    setBusy("buying");
    let result: PurchaseStatus = "error";
    try {
      result = await purchasePro();
    } finally {
      setBusy("idle");
    }
    if (result === "error") {
      setErrorMsg("Purchase failed. Please try again.");
    } else if (result === "pending") {
      setErrorMsg(
        "Your purchase is waiting for approval. We'll unlock Pro once it's approved.",
      );
    }
    // "granted" → the listener flips isPro; the effect above closes us.
    // "userCancelled" → leave the sheet open with no message.
  }, []);

  const handleRestore = useCallback(async () => {
    setErrorMsg(null);
    setBusy("restoring");
    try {
      await restorePurchases();
      if (!useUIStore.getState().isPro) {
        setErrorMsg("No previous purchase found on this Apple ID.");
      }
    } catch {
      setErrorMsg("Couldn't reach the App Store. Try again.");
    } finally {
      setBusy("idle");
    }
  }, []);

  const buyDisabled = busy !== "idle" || productUnavailable;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={guardedClose}
    >
      <Pressable style={styles.overlay} onPress={guardedClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>Maple View Pro</Text>
          <Text style={styles.subtitle}>
            {"Unlock larger grids to see more cameras at once."}
          </Text>

          <View style={styles.features}>
            {FEATURES.map((line) => (
              <View key={line} style={styles.featureRow}>
                <Ionicons name="checkmark-circle" size={20} color={ACCENT} />
                <Text style={styles.featureText}>{line}</Text>
              </View>
            ))}
          </View>

          {productUnavailable && (
            <Text style={styles.error}>
              This purchase isn&apos;t available right now. Check your
              connection and try again.
            </Text>
          )}
          {errorMsg && <Text style={styles.error}>{errorMsg}</Text>}

          <Pressable
            style={[styles.buyButton, buyDisabled && styles.buttonDisabled]}
            onPress={handleBuy}
            disabled={buyDisabled}
          >
            {busy === "buying" ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buyButtonText}>
                {price ? `Unlock — ${price}` : "Unlock Pro"}
              </Text>
            )}
          </Pressable>

          <Pressable
            style={styles.linkButton}
            onPress={handleRestore}
            disabled={busy !== "idle"}
          >
            {busy === "restoring" ? (
              <ActivityIndicator color={ACCENT} />
            ) : (
              <Text style={styles.linkText}>Restore Purchases</Text>
            )}
          </Pressable>

          <Pressable
            style={styles.linkButton}
            onPress={close}
            disabled={busy !== "idle"}
          >
            <Text style={styles.dismissText}>Maybe later</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#1C1C1E",
    borderRadius: 14,
    paddingVertical: 24,
    paddingHorizontal: 20,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    color: "#8E8E93",
    fontSize: 14,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 18,
  },
  features: {
    marginBottom: 18,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  featureText: {
    color: "#FFFFFF",
    fontSize: 15,
    flexShrink: 1,
  },
  error: {
    color: "#FF453A",
    fontSize: 13,
    textAlign: "center",
    marginBottom: 12,
  },
  buyButton: {
    backgroundColor: ACCENT,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 4,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buyButtonText: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
  },
  linkButton: {
    paddingVertical: 12,
    alignItems: "center",
  },
  linkText: {
    color: ACCENT,
    fontSize: 15,
  },
  dismissText: {
    color: "#8E8E93",
    fontSize: 15,
  },
});
