import {
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  restorePurchases as restorePurchasesNative,
  ErrorCode,
  type Product,
  type Purchase,
} from "expo-iap";

import { useUIStore } from "../store/ui-store";
import { debugLog } from "../utils/debug-log";

type PurchaseErrorArg = Parameters<
  Parameters<typeof purchaseErrorListener>[0]
>[0];

export const PRO_PRODUCT_ID = "com.luminationlabs.cameraview.pro_unlock";

export type PurchaseStatus =
  | "granted"
  | "userCancelled"
  | "pending"
  | "error";

let initialized = false;
let cachedProduct: Product | null = null;
let updateSub: { remove: () => void } | null = null;
let errorSub: { remove: () => void } | null = null;
let inFlightResolve: ((s: PurchaseStatus) => void) | null = null;

function resolveInFlight(status: PurchaseStatus): void {
  if (!inFlightResolve) return;
  inFlightResolve(status);
  inFlightResolve = null;
}

function applyPurchases(purchases: Purchase[]): void {
  const hasPro = purchases.some((p) => p.productId === PRO_PRODUCT_ID);
  const { isPro, setIsPro } = useUIStore.getState();
  if (hasPro !== isPro) setIsPro(hasPro);
}

async function handlePurchaseUpdate(purchase: Purchase): Promise<void> {
  if (purchase.productId !== PRO_PRODUCT_ID) return;

  // Apple may re-emit revoked transactions through the same listener
  // (refund propagation in StoreKit 2). Revoke the entitlement instead
  // of granting it.
  const revoked =
    "revocationDateIOS" in purchase && purchase.revocationDateIOS != null;
  if (revoked) {
    useUIStore.getState().setIsPro(false);
    resolveInFlight("error");
    return;
  }

  // Ask-to-Buy (parental approval) creates a pending transaction. Don't
  // grant Pro until it clears to 'purchased'.
  if (purchase.purchaseState === "pending") {
    resolveInFlight("pending");
    return;
  }

  if (purchase.purchaseState !== "purchased") return;

  try {
    await finishTransaction({ purchase, isConsumable: false });
  } catch {
    // Already-finished transactions throw; ignore.
  }
  useUIStore.getState().setIsPro(true);
  resolveInFlight("granted");
}

function handlePurchaseError(err: PurchaseErrorArg): void {
  resolveInFlight(
    err.code === ErrorCode.UserCancelled ? "userCancelled" : "error",
  );
}

export async function initialize(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await initConnection();
  updateSub = purchaseUpdatedListener(handlePurchaseUpdate);
  errorSub = purchaseErrorListener(handlePurchaseError);
}

export async function teardown(): Promise<void> {
  if (!initialized) return;
  updateSub?.remove();
  errorSub?.remove();
  updateSub = null;
  errorSub = null;
  await endConnection();
  initialized = false;
}

export async function getProduct(): Promise<Product | null> {
  if (cachedProduct) return cachedProduct;
  const products = await fetchProducts({
    skus: [PRO_PRODUCT_ID],
    type: "in-app",
  });
  const match = products?.find(
    (p) => p.id === PRO_PRODUCT_ID && p.type === "in-app",
  );
  cachedProduct = (match as Product | undefined) ?? null;
  return cachedProduct;
}

export async function syncEntitlement(): Promise<void> {
  try {
    const purchases = await getAvailablePurchases();
    applyPurchases(purchases);
  } catch (e) {
    debugLog.warn("[iap] syncEntitlement failed:", e);
  }
}

export async function purchasePro(): Promise<PurchaseStatus> {
  if (inFlightResolve) return "pending";
  return new Promise<PurchaseStatus>((resolve) => {
    inFlightResolve = resolve;
    requestPurchase({
      request: { apple: { sku: PRO_PRODUCT_ID } },
      type: "in-app",
    }).catch(() => {
      resolveInFlight("error");
    });
  });
}

export async function restorePurchases(): Promise<void> {
  await restorePurchasesNative();
  const purchases = await getAvailablePurchases();
  applyPurchases(purchases);
}
