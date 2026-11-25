import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  MerchantMetrics,
  MetricsResponse,
  NetworkMetrics,
  PlanMetrics,
} from "@substream/sdk";
import {
  isMetricsResponse,
  MAX_METRIC_PLANS,
  MAX_METRIC_TOKENS,
  MAX_METRICS_RESPONSE_CHARS,
} from "./metrics";

function makeNetwork(): NetworkMetrics {
  return {
    plansCreated: 1,
    planUpdates: 0,
    subscriptions: 2,
    topUps: 1,
    charges: 3,
    failedCharges: 1,
    cancellations: 0,
    charged: [{ token: "CTOKEN", amount: "1000" }],
    refunded: [],
  };
}

function makePlan(): PlanMetrics {
  return {
    planId: "7",
    subscriptions: 2,
    topUps: 1,
    charges: 3,
    failedCharges: 1,
    cancellations: 0,
    charged: [{ token: "CTOKEN", amount: "1000" }],
    refunded: [],
  };
}

function makeMerchant(): MerchantMetrics {
  return {
    merchant: "GMERCHANT",
    subscriptions: 2,
    topUps: 1,
    charges: 3,
    failedCharges: 1,
    cancellations: 0,
    charged: [{ token: "CTOKEN", amount: "1000" }],
    refunded: [],
    plans: [makePlan()],
  };
}

function makeResponse(overrides: Partial<MetricsResponse> = {}): MetricsResponse {
  return {
    network: makeNetwork(),
    indexedEvents: 12,
    lastLedger: 200,
    firstIndexedLedger: 180,
    ...overrides,
  };
}

test("accepts valid network and scoped metrics responses", () => {
  assert.equal(isMetricsResponse(makeResponse()), true);
  assert.equal(
    isMetricsResponse(makeResponse({ merchant: makeMerchant() })),
    true,
  );
});

test("rejects malformed counters, amounts, and nested metric objects", () => {
  assert.equal(
    isMetricsResponse(
      makeResponse({
        network: { ...makeNetwork(), charges: -1 },
      }),
    ),
    false,
  );
  assert.equal(
    isMetricsResponse(
      makeResponse({
        network: {
          ...makeNetwork(),
          charged: [{ token: "CTOKEN", amount: "1.5" }],
        },
      }),
    ),
    false,
  );
  assert.equal(
    isMetricsResponse(
      makeResponse({
        merchant: {
          ...makeMerchant(),
          plans: [{}] as unknown as PlanMetrics[],
        },
      }),
    ),
    false,
  );
  assert.equal(
    isMetricsResponse(makeResponse({ indexedEvents: Number.MAX_SAFE_INTEGER + 1 })),
    false,
  );
});

test("bounds token and plan arrays to the server's response caps", () => {
  const tokens = Array.from({ length: MAX_METRIC_TOKENS + 1 }, (_, index) => ({
    token: `CTOKEN${index}`,
    amount: "1",
  }));
  assert.equal(
    isMetricsResponse(
      makeResponse({ network: { ...makeNetwork(), charged: tokens } }),
    ),
    false,
  );
  assert.equal(
    isMetricsResponse(
      makeResponse({
        network: {
          ...makeNetwork(),
          charged: tokens.slice(0, MAX_METRIC_TOKENS),
        },
      }),
    ),
    true,
  );

  const plans = Array.from({ length: MAX_METRIC_PLANS + 1 }, () => makePlan());
  assert.equal(
    isMetricsResponse(
      makeResponse({ merchant: { ...makeMerchant(), plans } }),
    ),
    false,
  );
});

test("the metrics body cap is larger than the event body cap", () => {
  assert.ok(MAX_METRICS_RESPONSE_CHARS > 1_000_000);
});
