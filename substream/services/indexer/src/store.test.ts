import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventStore } from "./store";
import type { IndexedEvent } from "@substream/sdk";

function event(id: string, ledger: number, subscriber: string): IndexedEvent {
  return {
    id,
    kind: "charged",
    subscriptionId: "1",
    planId: "1",
    subscriber,
    amount: "1000",
    balance: "0",
    nextCharge: "200",
    reason: null,
    txHash: `tx-${id}`,
    ledger,
    timestamp: 1_700_000_000 + ledger,
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
