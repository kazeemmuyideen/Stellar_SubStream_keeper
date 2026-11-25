import type { MetricsResponse } from "@substream/sdk";

/** Metrics payloads can be larger than the bounded /events response. */
export const MAX_METRICS_RESPONSE_CHARS = 4_000_000;
export const MAX_METRIC_TOKENS = 100;
export const MAX_METRIC_PLANS = 100;

const NETWORK_METRIC_KEYS = [
  "plansCreated",
  "planUpdates",
  "subscriptions",
  "topUps",
  "charges",
  "failedCharges",
  "cancellations",
] as const;

const MERCHANT_METRIC_KEYS = [
  "subscriptions",
  "topUps",
  "charges",
  "failedCharges",
  "cancellations",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCount(value: unknown): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  );
}

function isTokenAmounts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_METRIC_TOKENS &&
    value.every((item) => {
      if (!isRecord(item)) return false;
      return (
        typeof item.token === "string" &&
        item.token.length > 0 &&
        typeof item.amount === "string" &&
        /^\d+$/.test(item.amount)
      );
    })
  );
}

function hasCounts(
  source: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => isCount(source[key]));
}

function isPlanMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.planId === "string" &&
    value.planId.length > 0 &&
    hasCounts(value, MERCHANT_METRIC_KEYS) &&
    isTokenAmounts(value.charged) &&
    isTokenAmounts(value.refunded)
  );
}

function isMerchantMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.merchant === "string" &&
    value.merchant.length > 0 &&
    hasCounts(value, MERCHANT_METRIC_KEYS) &&
    isTokenAmounts(value.charged) &&
    isTokenAmounts(value.refunded) &&
    Array.isArray(value.plans) &&
    value.plans.length <= MAX_METRIC_PLANS &&
    value.plans.every(isPlanMetrics)
  );
}

/** Treat any malformed indexer payload as "offline" instead of crashing. */
export function isMetricsResponse(value: unknown): value is MetricsResponse {
  if (!isRecord(value) || !isRecord(value.network)) return false;
  const network = value.network;
  if (
    !hasCounts(network, NETWORK_METRIC_KEYS) ||
    !isTokenAmounts(network.charged) ||
    !isTokenAmounts(network.refunded)
  ) {
    return false;
  }
  if (value.indexedEvents !== undefined && !isCount(value.indexedEvents)) {
    return false;
  }
  if (
    value.lastLedger !== undefined &&
    value.lastLedger !== null &&
    !isCount(value.lastLedger)
  ) {
    return false;
  }
  if (
    value.firstIndexedLedger !== undefined &&
    value.firstIndexedLedger !== null &&
    !isCount(value.firstIndexedLedger)
  ) {
    return false;
  }
  return value.merchant === undefined || isMerchantMetrics(value.merchant);
}
