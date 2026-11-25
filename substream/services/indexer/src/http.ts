import { StrKey } from "@stellar/stellar-sdk";
import type { IndexerConfig } from "./config";
import type { EventStore } from "./store";

/** `null` means the caller should send an empty 204 response. */
export type IndexerResult = { status: number; body: unknown } | null;

function isMerchantAddress(value: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)
  );
}

export function handleIndexerRequest(
  method: string | undefined,
  url: URL,
  store: EventStore,
  config: IndexerConfig,
): IndexerResult {
  if (method === "OPTIONS") return null;
  if (method !== "GET") {
    return { status: 405, body: { error: "Method not allowed" } };
  }

  if (url.pathname === "/health") {
    return {
      status: 200,
      body: {
        ok: true,
        contractId: config.contractId,
        lastLedger: store.lastLedger,
        events: store.size,
      },
    };
  }

  if (url.pathname === "/events") {
    const rawLimit = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(1, Math.floor(rawLimit)), 500)
      : 100;
    return {
      status: 200,
      body: {
        events: store.query({
          subscriber: url.searchParams.get("subscriber") ?? undefined,
          subscriptionId:
            url.searchParams.get("subscriptionId") ?? undefined,
          limit,
        }),
        cursor: store.cursor ?? null,
        lastLedger: store.lastLedger,
        indexed: store.size,
      },
    };
  }

  if (url.pathname === "/stats") {
    return {
      status: 200,
      body: {
        events: store.size,
        lastLedger: store.lastLedger,
        byKind: store.eventCounts,
      },
    };
  }

  if (url.pathname === "/metrics") {
    const merchant = url.searchParams.get("merchant")?.trim() || undefined;
    if (merchant && !isMerchantAddress(merchant)) {
      return { status: 400, body: { error: "Invalid merchant address" } };
    }
    return { status: 200, body: store.summary(merchant) };
  }

  return { status: 404, body: { error: "Not found" } };
}
