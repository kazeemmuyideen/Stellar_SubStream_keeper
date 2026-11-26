import assert from "node:assert/strict";
import test from "node:test";

import { backoffDelay, KeeperMetrics, renderPrometheus } from "./metrics";

test("metrics count ticks, charges, and outcomes", () => {
  const metrics = new KeeperMetrics(1_000);
  metrics.tickStarted(1_100);
  metrics.tickSucceeded(2, 1_200);
  metrics.chargeAttempted();
  metrics.chargeSucceeded("Insufficient escrow");
  metrics.chargeAttempted();
  metrics.chargeSucceeded("Charged");
  metrics.chargeFailed();
  metrics.dryRun();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.startedAt, 1_000);
  assert.equal(snapshot.lastTickAt, 1_100);
  assert.equal(snapshot.lastSuccessAt, 1_200);
  assert.equal(snapshot.ticks, 1);
  assert.equal(snapshot.tickFailures, 0);
  assert.equal(snapshot.consecutiveFailures, 0);
  assert.equal(snapshot.dueFound, 2);
  assert.equal(snapshot.chargeAttempts, 2);
  assert.equal(snapshot.chargeFailures, 1);
  assert.equal(snapshot.dryRuns, 1);
  assert.deepEqual(snapshot.outcomes, {
    insufficient_escrow: 1,
    charged: 1,
  });

  snapshot.outcomes.charged = 99;
  assert.equal(metrics.snapshot().outcomes.charged, 1);
});

test("consecutive failures reset after a successful tick", () => {
  const metrics = new KeeperMetrics();
  metrics.tickStarted();
  metrics.tickFailed();
  metrics.tickStarted();
  metrics.tickFailed();
  assert.equal(metrics.snapshot().consecutiveFailures, 2);
  metrics.tickStarted();
  metrics.tickSucceeded(0);
  assert.equal(metrics.snapshot().consecutiveFailures, 0);
  assert.equal(metrics.snapshot().tickFailures, 2);
});

test("backoff grows, caps, jitters, and rejects invalid inputs", () => {
  assert.equal(backoffDelay(1, 1_000, 60_000, () => 0), 500);
  assert.equal(backoffDelay(1, 1_000, 60_000, () => 1), 1_000);
  assert.equal(backoffDelay(2, 1_000, 60_000, () => 0), 1_000);
  assert.equal(backoffDelay(2, 1_000, 60_000, () => 1), 2_000);
  assert.equal(backoffDelay(20, 1_000, 5_000, () => 0), 2_500);
  assert.equal(backoffDelay(20, 1_000, 5_000, () => 1), 5_000);
  assert.throws(() => backoffDelay(0, 1_000, 5_000), /positive integer/);
  assert.throws(() => backoffDelay(1, 0, 5_000), /bounds/);
  assert.throws(() => backoffDelay(1, 5_000, 1_000), /bounds/);
});

test("Prometheus output uses bounded sanitized outcome labels", () => {
  const metrics = new KeeperMetrics(0);
  metrics.tickStarted(2_000);
  metrics.tickFailed(3_000);
  metrics.chargeAttempted();
  metrics.chargeSucceeded("Insufficient escrow");
  const text = renderPrometheus(metrics.snapshot());
  assert.match(text, /keeper_start_time_seconds 0/);
  assert.match(text, /keeper_last_tick_time_seconds 2/);
  assert.match(text, /keeper_last_failure_time_seconds 3/);
  assert.match(text, /keeper_tick_failures_total 1/);
  assert.match(text, /keeper_charge_outcomes_total\{outcome="insufficient_escrow"\} 1/);
  assert.doesNotMatch(text, /S[A-Z2-7]{55}/);
});
