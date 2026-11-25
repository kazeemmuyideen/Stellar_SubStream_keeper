import { scValToNative, type rpc } from "@stellar/stellar-sdk";
import {
  EventKind,
  type EventKindValue,
  type IndexedEvent,
} from "@substream/sdk";

const KINDS = new Set<string>(Object.values(EventKind));

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint" || typeof value === "string") {
    return value.toString();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function asSmallInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return null;
}

/** Decode one contract event into the JSON-safe shape served by the API. */
export function parseEvent(
  event: rpc.Api.EventResponse,
): IndexedEvent | null {
  try {
    const topic = event.topic.map((value) => scValToNative(value));
    const kind = topic[0];
    if (typeof kind !== "string" || !KINDS.has(kind)) return null;

    const data = scValToNative(event.value) as Record<string, unknown>;
    if (!data || typeof data !== "object") return null;

    // Every SubStream event puts its record id in the second topic. Plan
    // events carry a plan id; all other events carry a subscription id.
    const topicId = asString(topic[1]);
    const isPlanEvent = kind === "plan_new" || kind === "plan_upd";

    const closedAt = Date.parse(event.ledgerClosedAt);
    const timestamp = Number.isFinite(closedAt)
      ? Math.floor(closedAt / 1_000)
      : 0;

    return {
      id: event.id,
      kind: kind as EventKindValue,
      subscriptionId: isPlanEvent ? null : topicId,
      planId: isPlanEvent ? topicId : asString(data.plan_id),
      subscriber: asString(data.subscriber) ?? asString(data.merchant),
      merchant: asString(data.merchant),
      token: asString(data.token),
      amount:
        asString(data.amount) ??
        asString(data.deposit) ??
        asString(data.refund),
      balance: asString(data.balance),
      nextCharge: asString(data.next_charge),
      reason: asSmallInteger(data.reason),
      txHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    };
  } catch {
    // Malformed or non-SubStream events are ignored rather than stalling the
    // poller. The RPC filter already restricts this to our contract.
    return null;
  }
}
