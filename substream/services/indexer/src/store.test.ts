import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventStore } from "./store";
import type { IndexedEvent } from "@substream/sdk";

function event(
  id: string,
  ledger: number,
  subscriber: string | null,
  overrides: Partial<IndexedEvent> = {},
): IndexedEvent {
  return {
    id,
    kind: "charged",
    subscriptionId: "1",
    planId: "1",
    subscriber,
    merchant: "GMERCHANT",
    token: "CTOKEN",
    amount: "1000",
    balance: "0",
    nextCharge: "200",
    reason: null,
    txHash: `tx-${id}`,
    ledger,
    timestamp: 1_700_000_000 + ledger,
    ...overrides,
  };
}

test("store deduplicates, filters, persists, and reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "substream-indexer-"));
  const stateFile = join(directory, "state.json");

  try {
    const store = new EventStore(stateFile, 100);
    await store.load();
    store.initialize(100);

    assert.equal(
      store.add(
        [event("a", 101, "GALICE"), event("b", 102, "GBBOB")],
        "cursor-1",
        102,
      ),
      2,
    );
    assert.equal(store.add([event("a", 101, "GALICE")], "cursor-2", 103), 0);
    await store.persist();

    const reloaded = new EventStore(stateFile, 100);
    await reloaded.load();

    assert.equal(reloaded.size, 2);
    assert.equal(reloaded.cursor, "cursor-2");
    assert.equal(reloaded.startLedger, 100);
    assert.equal(reloaded.lastLedger, 103);
    assert.deepEqual(
      reloaded.query({ subscriber: "GALICE", limit: 10 }).map((item) => item.id),
      ["a"],
    );
    assert.deepEqual(
      reloaded.query({ subscriptionId: "1", limit: 1 }).map((item) => item.id),
      ["b"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reanchor clears the cursor but keeps collected events", () => {
  const store = new EventStore("unused.json", 100);
  store.initialize(10);
  store.add([event("a", 11, "G")], "stale-cursor", 11);
  store.reanchor(500);

  assert.equal(store.cursor, undefined);
  assert.equal(store.startLedger, 500);
  assert.equal(store.lastLedger, 499);
  assert.equal(store.size, 1);
});

test("store caps retained events", () => {
  const store = new EventStore("unused.json", 2);
  store.initialize(1);
  store.add([event("a", 1, "G"), event("b", 2, "G"), event("c", 3, "G")], "c", 3);
  assert.equal(store.size, 2);
  assert.deepEqual(
    store.query({ limit: 10 }).map((item) => item.id),
    ["c", "b"],
  );
  assert.deepEqual(store.eventCounts, { charged: 2 });
});

test("corrupt state is quarantined and starts fresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "substream-indexer-"));
  const stateFile = join(directory, "state.json");

  try {
    await writeFile(stateFile, "{not json");
    const store = new EventStore(stateFile, 100);
    assert.equal(await store.load(), true);
    assert.equal(store.size, 0);

    const files = await readdir(directory);
    assert.equal(files.some((file) => file.includes("corrupt")), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("metrics aggregate the merchant lifecycle into scoped summaries", () => {
  const store = new EventStore("unused.json", 100);
  store.initialize(100);

  const added = store.add(
    [
      event("plan", 101, "GMERCHANT", {
        kind: "plan_new",
        subscriptionId: null,
        planId: "1",
        amount: null,
        balance: null,
        nextCharge: null,
      }),
      event("sub", 102, "GSUBSCRIBER", {
        kind: "subscribe",
        subscriptionId: "10",
        merchant: null,
        token: null,
        amount: "3000",
        balance: "3000",
      }),
      event("charge", 103, "GSUBSCRIBER", {
        subscriptionId: "10",
        merchant: "GMERCHANT",
        token: null,
        amount: "1000",
        balance: "2000",
      }),
      event("fail", 104, "GSUBSCRIBER", {
        kind: "pay_fail",
        subscriptionId: "10",
        merchant: null,
        token: null,
        amount: null,
        balance: "0",
      }),
      event("topup", 105, "GSUBSCRIBER", {
        kind: "topped_up",
        subscriptionId: "10",
        planId: null,
        merchant: null,
        token: null,
        amount: "1000",
        balance: "1000",
      }),
      event("cancel", 106, "GSUBSCRIBER", {
        kind: "cancelled",
        subscriptionId: "10",
        planId: null,
        merchant: null,
        token: null,
        amount: "500",
        balance: "0",
        reason: 1,
      }),
    ],
    "cursor-6",
    106,
  );
  assert.equal(added, 6);

  const summary = store.summary("GMERCHANT");
  assert.deepEqual(summary.network, {
    plansCreated: 1,
    planUpdates: 0,
    subscriptions: 1,
    topUps: 1,
    charges: 1,
    failedCharges: 1,
    cancellations: 1,
    charged: [{ token: "CTOKEN", amount: "1000" }],
    refunded: [{ token: "CTOKEN", amount: "500" }],
  });
  assert.deepEqual(summary.merchant, {
    merchant: "GMERCHANT",
    subscriptions: 1,
    topUps: 1,
    charges: 1,
    failedCharges: 1,
    cancellations: 1,
    charged: [{ token: "CTOKEN", amount: "1000" }],
    refunded: [{ token: "CTOKEN", amount: "500" }],
    plans: [
      {
        planId: "1",
        subscriptions: 1,
        topUps: 1,
        charges: 1,
        failedCharges: 1,
        cancellations: 1,
        charged: [{ token: "CTOKEN", amount: "1000" }],
        refunded: [{ token: "CTOKEN", amount: "500" }],
      },
    ],
  });
  assert.equal(summary.firstIndexedLedger, 101);
  assert.equal(summary.lastLedger, 106);
  assert.equal(store.summary("GOTHER").merchant, undefined);
});

test("metrics survive event trimming and deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "substream-indexer-"));
  const stateFile = join(directory, "state.json");

  try {
    const store = new EventStore(stateFile, 2);
    store.initialize(100);
    store.add(
      [
        event("plan", 101, "GMERCHANT", {
          kind: "plan_new",
          subscriptionId: null,
          amount: null,
          balance: null,
          nextCharge: null,
        }),
        event("sub", 102, "GSUBSCRIBER", {
          kind: "subscribe",
          subscriptionId: "10",
          merchant: null,
          token: null,
          amount: "1000",
          balance: "1000",
        }),
        event("charge", 103, "GSUBSCRIBER", {
          subscriptionId: "10",
          amount: "1000",
        }),
      ],
      "cursor-3",
      103,
    );
    assert.equal(store.size, 2);
    await store.persist();

    const reloaded = new EventStore(stateFile, 2);
    assert.equal(await reloaded.load(), false);
    assert.equal(
      reloaded.add([event("charge", 103, "GSUBSCRIBER")], "cursor-4", 104),
      0,
    );

    const merchant = reloaded.summary("GMERCHANT").merchant;
    assert.ok(merchant);
    assert.equal(merchant.subscriptions, 1);
    assert.equal(merchant.charges, 1);
    assert.deepEqual(merchant.charged, [{ token: "CTOKEN", amount: "1000" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy state without metrics is rebuilt from retained events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "substream-indexer-"));
  const stateFile = join(directory, "state.json");

  try {
    await writeFile(
      stateFile,
      JSON.stringify({
        cursor: "cursor-2",
        startLedger: 100,
        lastLedger: 102,
        events: [
          event("plan", 101, "GMERCHANT", {
            kind: "plan_new",
            subscriptionId: null,
            amount: null,
            balance: null,
            nextCharge: null,
          }),
          event("charge", 102, "GSUBSCRIBER", {
            subscriptionId: "10",
            amount: "2500",
          }),
        ],
      }),
    );

    const store = new EventStore(stateFile, 100);
    assert.equal(await store.load(), false);
    assert.equal(store.summary("GMERCHANT").merchant?.charges, 1);
    assert.deepEqual(store.summary().network.charged, [
      { token: "CTOKEN", amount: "2500" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reanchoring does not recompute events trimmed from the cache", () => {
  const store = new EventStore("unused.json", 2);
  store.initialize(100);
  const events = [
    event("plan", 101, "GMERCHANT", {
      kind: "plan_new",
      subscriptionId: null,
      amount: null,
      balance: null,
      nextCharge: null,
    }),
    event("sub", 102, "GSUBSCRIBER", {
      kind: "subscribe",
      subscriptionId: "10",
      merchant: null,
      token: null,
      amount: "1000",
      balance: "1000",
    }),
    event("charge", 103, "GSUBSCRIBER", {
      subscriptionId: "10",
      amount: "1000",
    }),
  ];

  assert.equal(store.add(events, "cursor-3", 103), 3);
  store.reanchor(101);
  assert.equal(store.add(events, "cursor-3-again", 103), 0);

  const network = store.summary().network;
  assert.equal(network.plansCreated, 1);
  assert.equal(network.subscriptions, 1);
  assert.equal(network.charges, 1);
  assert.deepEqual(network.charged, [{ token: "CTOKEN", amount: "1000" }]);
});

test("reanchoring keeps lastLedger within the retained event window", () => {
  const store = new EventStore("unused.json", 100);
  store.initialize(100);
  store.add(
    [
      event("a", 101, "GSUBSCRIBER"),
      event("b", 102, "GSUBSCRIBER"),
    ],
    "cursor-2",
    102,
  );

  store.reanchor(101);
  const summary = store.summary();
  assert.equal(store.lastLedger, 102);
  assert.equal(summary.firstIndexedLedger, 101);
  assert.ok(summary.lastLedger! >= summary.firstIndexedLedger!);
});

test("persisted metric values are sanitized and large amounts stay exact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "substream-indexer-"));
  const stateFile = join(directory, "state.json");

  try {
    await writeFile(
      stateFile,
      JSON.stringify({
        events: [],
        metrics: {
          network: {
            counters: {
              plansCreated: -1,
              planUpdates: Number.MAX_SAFE_INTEGER + 1,
              subscriptions: 2,
              topUps: 0,
              charges: 0,
              failedCharges: 0,
              cancellations: 0,
            },
            charged: { CNEG: "-5", CBAD: "1.5", CGOOD: "7" },
            refunded: {},
          },
          merchants: {},
          plans: {},
          subscriptions: {},
        },
      }),
    );

    const store = new EventStore(stateFile, 100);
    assert.equal(await store.load(), false);
    const network = store.summary().network;
    assert.equal(network.plansCreated, 0);
    assert.equal(network.planUpdates, 0);
    assert.equal(network.subscriptions, 2);
    assert.deepEqual(network.charged, [{ token: "CGOOD", amount: "7" }]);

    store.add(
      [
        event("huge-1", 1, "GSUBSCRIBER", {
          amount: "9007199254740993",
        }),
        event("huge-2", 2, "GSUBSCRIBER", {
          amount: "9007199254740993",
        }),
      ],
      "cursor-2",
      2,
    );
    assert.deepEqual(store.summary().network.charged, [
      { token: "CGOOD", amount: "7" },
      { token: "CTOKEN", amount: "18014398509481986" },
    ]);
    assert.deepEqual(store.summary("GMERCHANT").merchant?.charged, [
      { token: "CTOKEN", amount: "18014398509481986" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("token totals are capped to keep responses bounded", () => {
  const store = new EventStore("unused.json", 200);
  store.initialize(1);
  const events = Array.from({ length: 101 }, (_, index) =>
    event(`token-${index}`, index + 1, "GSUBSCRIBER", {
      amount: "1",
      token: `CTOKEN${index}`,
    }),
  );

  store.add(events, "cursor-101", 101);
  assert.equal(store.summary().network.charged.length, 100);
  assert.equal(store.summary("GMERCHANT").merchant?.charged.length, 100);
});
