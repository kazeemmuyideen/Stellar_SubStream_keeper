import assert from "node:assert/strict";
import test from "node:test";
import { SubscriptionStatus, type Subscription } from "@substream/sdk";
import {
  demoStage,
  filterSubscriptions,
  isDue,
  type DemoState,
} from "./dashboard";

function subscription(
  id: number,
  status: number,
  nextCharge: bigint,
): Subscription {
  return {
    id: BigInt(id),
    planId: 1n,
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    subscriber: `GBZZVBFJTX23YRYGYID6P4YHESDHYZFWKOBPMQSFKHLBHJZMHTXDIFP${id}`,
    amount: 10_000_000n,
    interval: 60n,
    gracePeriod: 3600n,
    balance: 20_000_000n,
    nextCharge,
    status,
    cyclesPaid: 0,
    startedAt: 1n,
    lastChargedAt: 0n,
  };
}

test("isDue ignores cancelled subscriptions", () => {
  assert.equal(isDue(subscription(1, SubscriptionStatus.Active, 10n), 10n), true);
  assert.equal(isDue(subscription(2, SubscriptionStatus.PastDue, 11n), 10n), false);
  assert.equal(
    isDue(subscription(3, SubscriptionStatus.Cancelled, 1n), 10n),
    false,
  );
});

test("filterSubscriptions filters by status and search text", () => {
  const subscriptions = [
    subscription(1, SubscriptionStatus.Active, 10n),
    subscription(2, SubscriptionStatus.PastDue, 10n),
    subscription(3, SubscriptionStatus.Cancelled, 10n),
  ];

  assert.equal(filterSubscriptions(subscriptions, "all", "").length, 3);
  assert.equal(filterSubscriptions(subscriptions, "active", "").length, 1);
  assert.equal(filterSubscriptions(subscriptions, "past-due", "").length, 1);
  assert.equal(filterSubscriptions(subscriptions, "cancelled", "").length, 1);

  const byId = filterSubscriptions(subscriptions, "all", "P2");
  assert.deepEqual(
    byId.map((item) => item.id),
    [2n],
  );

  const byAddress = filterSubscriptions(subscriptions, "active", "GBZZ");
  assert.equal(byAddress.length, 1);
});

test("demoStage advances through the lifecycle", () => {
  const base: DemoState = {
    connected: true,
    hasPlan: true,
    hasSubscription: true,
    hasDueSubscription: false,
    hasCancelledSubscription: false,
  };

  assert.equal(
    demoStage({ ...base, connected: false, hasPlan: false, hasSubscription: false }),
    "connect",
  );
  assert.equal(demoStage({ ...base, hasPlan: false, hasSubscription: false }), "create-plan");
  assert.equal(demoStage({ ...base, hasSubscription: false }), "subscribe");
  assert.equal(demoStage(base), "wait");
  assert.equal(demoStage({ ...base, hasDueSubscription: true }), "charge");
  assert.equal(
    demoStage({ ...base, hasDueSubscription: true, hasCancelledSubscription: true }),
    "complete",
  );
});
