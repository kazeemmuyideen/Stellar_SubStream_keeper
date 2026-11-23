import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { EventKind } from "@substream/sdk";
import { parseEvent } from "./events";

function fakeEvent(
  kind: string,
  data: Record<string, unknown>,
  overrides: Partial<rpc.Api.EventResponse> = {},
): rpc.Api.EventResponse {
  return {
    id: "0000000000000001-0000000000",
    type: "contract",
    ledger: 123,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash: "abc123",
    topic: [
      nativeToScVal(kind, { type: "symbol" }),
      nativeToScVal(7n, { type: "u64" }),
    ],
    value: nativeToScVal(data),
    ...overrides,
  } as rpc.Api.EventResponse;
}

test("decodes a charged event into a JSON-safe record", () => {
  const event = parseEvent(
    fakeEvent(EventKind.Charged, {
      plan_id: 1n,
      subscriber: "GSUBSCRIBER",
      amount: 10_000_000n,
      next_charge: 1_700_100_000n,
    }),
  );

  assert.ok(event);
  assert.equal(event.kind, "charged");
  assert.equal(event.subscriptionId, "7");
  assert.equal(event.planId, "1");
  assert.equal(event.subscriber, "GSUBSCRIBER");
  assert.equal(event.amount, "10000000");
  assert.equal(event.nextCharge, "1700100000");
  assert.equal(event.txHash, "abc123");
  assert.equal(event.ledger, 123);
  assert.equal(event.timestamp, 1_767_225_600);
});

test("decodes cancellation reasons and ignores unknown topics", () => {
  const cancelled = parseEvent(
    fakeEvent(EventKind.Cancelled, {
      subscriber: "GSUBSCRIBER",
      refund: 0n,
      reason: 1n,
    }),
  );
  assert.equal(cancelled?.kind, "cancelled");
  assert.equal(cancelled?.reason, 1);

  assert.equal(parseEvent(fakeEvent("unknown_event", {})), null);
});
