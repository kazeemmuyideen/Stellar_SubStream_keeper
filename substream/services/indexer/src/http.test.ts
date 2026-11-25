import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { test } from "node:test";
import type { IndexerConfig } from "./config";
import { handleIndexerRequest } from "./http";
import type { EventStore } from "./store";

const merchant = Keypair.fromRawEd25519Seed(new Uint8Array(32)).publicKey();
const base = "http://localhost:8787";
const config = { contractId: "CTEST" } as IndexerConfig;

function fakeStore() {
  const summaries: Array<string | undefined> = [];
  const queries: unknown[] = [];
  const store = {
    query: (query: unknown) => {
      queries.push(query);
      return [];
    },
    summary: (scope?: string) => {
      summaries.push(scope);
      return {
        network: {
          plansCreated: 0,
          planUpdates: 0,
          subscriptions: 0,
          topUps: 0,
          charges: 2,
          failedCharges: 1,
          cancellations: 0,
          charged: [],
          refunded: [],
        },
        merchant: scope ? { merchant: scope } : undefined,
        indexedEvents: 3,
        lastLedger: 100,
        firstIndexedLedger: 98,
      };
    },
    eventCounts: {},
    size: 3,
    lastLedger: 100,
    cursor: "cursor-1",
  } as unknown as EventStore;
  return { store, summaries, queries };
}

test("GET /health reports store status", () => {
  const { store } = fakeStore();
  const result = handleIndexerRequest(
    "GET",
    new URL("/health", base),
    store,
    config,
  );
  assert.deepEqual(result, {
    status: 200,
    body: {
      ok: true,
      contractId: "CTEST",
      lastLedger: 100,
      events: 3,
    },
  });
});

test("GET /events forwards filters and clamps the limit", () => {
  const { store, queries } = fakeStore();
  const result = handleIndexerRequest(
    "GET",
    new URL("/events?subscriber=GSUB&subscriptionId=10&limit=1000", base),
    store,
    config,
  );
  assert.deepEqual(queries, [
    { subscriber: "GSUB", subscriptionId: "10", limit: 500 },
  ]);
  assert.deepEqual(result, {
    status: 200,
    body: {
      events: [],
      cursor: "cursor-1",
      lastLedger: 100,
      indexed: 3,
    },
  });
});

test("GET /stats reports retained event counts by kind", () => {
  const { store } = fakeStore();
  const result = handleIndexerRequest(
    "GET",
    new URL("/stats", base),
    store,
    config,
  );
  assert.deepEqual(result, {
    status: 200,
    body: { events: 3, lastLedger: 100, byKind: {} },
  });
});

test("GET /metrics serves scoped and unscoped summaries", () => {
  const scoped = fakeStore();
  const scopedResult = handleIndexerRequest(
    "GET",
    new URL(`/metrics?merchant=${merchant}`, base),
    scoped.store,
    config,
  );
  assert.equal(scopedResult?.status, 200);
  assert.deepEqual(scoped.summaries, [merchant]);

  const network = fakeStore();
  const networkResult = handleIndexerRequest(
    "GET",
    new URL("/metrics", base),
    network.store,
    config,
  );
  assert.equal(networkResult?.status, 200);
  assert.deepEqual(network.summaries, [undefined]);
  assert.equal(
    (networkResult?.body as { network: { charges: number } }).network.charges,
    2,
  );
});

test("GET /metrics rejects an invalid merchant address", () => {
  const { store, summaries } = fakeStore();
  const result = handleIndexerRequest(
    "GET",
    new URL("/metrics?merchant=not-a-key", base),
    store,
    config,
  );
  assert.equal(result?.status, 400);
  assert.deepEqual(summaries, []);
});

test("HTTP methods and unknown routes are handled", () => {
  const { store } = fakeStore();
  assert.equal(
    handleIndexerRequest("POST", new URL("/metrics", base), store, config)
      ?.status,
    405,
  );
  assert.equal(
    handleIndexerRequest("OPTIONS", new URL("/metrics", base), store, config),
    null,
  );
  assert.equal(
    handleIndexerRequest("GET", new URL("/unknown", base), store, config)
      ?.status,
    404,
  );
});
