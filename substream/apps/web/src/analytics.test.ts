import assert from "node:assert/strict";
import test from "node:test";
import type { MetricsResponse } from "@substream/sdk";
import {
  formatBps,
  metricsToCsv,
  shareBps,
  successRateBps,
  tokenShares,
} from "./analytics";

const token = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const payload: MetricsResponse = {
  network: {
    plansCreated: 2,
    planUpdates: 1,
    subscriptions: 5,
    topUps: 1,
    charges: 4,
    failedCharges: 1,
    cancellations: 2,
    charged: [{ token, amount: "40000000" }],
    refunded: [{ token, amount: "10000000" }],
  },
  merchant: {
    merchant: "GBZZVBFJTX23YRYGYID6P4YHESDHYZFWKOBPMQSFKHLBHJZMHTXDIFPB",
    subscriptions: 3,
    topUps: 1,
    charges: 4,
    failedCharges: 1,
    cancellations: 2,
    charged: [{ token, amount: "40000000" }],
    refunded: [{ token, amount: "10000000" }],
    plans: [
      {
        planId: "2",
        subscriptions: 3,
        topUps: 1,
        charges: 4,
        failedCharges: 1,
        cancellations: 2,
        charged: [{ token, amount: "40000000" }],
        refunded: [{ token, amount: "10000000" }],
      },
    ],
  },
  indexedEvents: 12,
  lastLedger: 5_936_155,
  firstIndexedLedger: 5_936_100,
};

test("shareBps computes bounded percentages from base-unit strings", () => {
  assert.equal(shareBps("25000000", 100_000_000n), 2500);
  assert.equal(shareBps("-1", 100n), 0);
  assert.equal(shareBps("oops", 100n), 0);
  assert.equal(shareBps("1", 0n), 0);
});

test("tokenShares preserves tokens and computes shares", () => {
  const shares = tokenShares([
    { token: "a", amount: "30000000" },
    { token: "b", amount: "10000000" },
  ]);
  assert.deepEqual(
    shares.map((item) => [item.token, item.shareBps]),
    [
      ["a", 7500],
      ["b", 2500],
    ],
  );
});

test("successRateBps handles empty and partial samples", () => {
  assert.equal(successRateBps(0, 0), null);
  assert.equal(successRateBps(4, 1), 8000);
  assert.equal(formatBps(null), "—");
  assert.equal(formatBps(8000), "80.00%");
});

test("metricsToCsv flattens network, merchant, plan, and token rows", () => {
  const csv = metricsToCsv(payload);
  assert.match(csv, /^"scope","group","key","value"/);
  assert.match(csv, /"network","counters","charges","4"/);
  assert.match(csv, /"network","charged","CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC","40000000"/);
  assert.match(csv, /"merchant","plan:2","charges","4"/);
  assert.match(csv, /"merchant","plan:2:refunded"/);
  assert.match(csv, /"network","context","lastLedger","5936155"/);
});

test("metricsToCsv neutralizes spreadsheet formulas and escapes quotes", () => {
  const hostile: MetricsResponse = {
    ...payload,
    merchant: {
      ...payload.merchant!,
      merchant: '=HYPERLINK("x","y")',
    },
  };
  const csv = metricsToCsv(hostile);
  assert.match(csv, /"'=HYPERLINK\(""x"",""y""\)"/);
});
