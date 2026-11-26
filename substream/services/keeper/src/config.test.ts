import assert from "node:assert/strict";
import test from "node:test";

import { boundedInt, loadConfig } from "./config";

const SECRET = `S${"A".repeat(55)}`;
const KEYS = [
  "CONTRACT_ID",
  "KEEPER_SECRET",
  "POLL_INTERVAL_MS",
  "MAX_SUBSCRIPTIONS",
  "ALLOW_HTTP",
  "METRICS_HOST",
  "METRICS_PORT",
  "RETRY_BASE_MS",
  "RETRY_MAX_MS",
];

function setValidEnv(): void {
  process.env.CONTRACT_ID = "CFAKE";
  process.env.KEEPER_SECRET = SECRET;
}

test("boundedInt rejects NaN, negative, and oversized values", () => {
  process.env.TEST_MAX = "Infinity";
  assert.throws(() => boundedInt("TEST_MAX", 200, 1, 500), /between/);
  process.env.TEST_MAX = "-1";
  assert.throws(() => boundedInt("TEST_MAX", 200, 1, 500), /between/);
  process.env.TEST_MAX = "99999";
  assert.throws(() => boundedInt("TEST_MAX", 200, 1, 500), /between/);
  process.env.TEST_MAX = "250";
  assert.equal(boundedInt("TEST_MAX", 200, 1, 500), 250);
  delete process.env.TEST_MAX;
});

test("keeper config validates poll and scan bounds", () => {
  setValidEnv();
  const config = loadConfig();
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.maxSubscriptions, 200);
  assert.equal(config.allowHttp, false);
  assert.equal(config.metricsHost, "127.0.0.1");
  assert.equal(config.metricsPort, 8788);
  assert.equal(config.retryBaseMs, 1_000);
  assert.equal(config.retryMaxMs, 60_000);

  process.env.POLL_INTERVAL_MS = "1";
  assert.throws(() => loadConfig(), /POLL_INTERVAL_MS/);
  process.env.POLL_INTERVAL_MS = "30000";

  process.env.MAX_SUBSCRIPTIONS = "0";
  assert.throws(() => loadConfig(), /MAX_SUBSCRIPTIONS/);
  process.env.MAX_SUBSCRIPTIONS = "999";
  assert.throws(() => loadConfig(), /MAX_SUBSCRIPTIONS/);
  process.env.MAX_SUBSCRIPTIONS = "200";

  for (const key of KEYS) delete process.env[key];
});

test("keeper config validates metrics and retry settings", () => {
  setValidEnv();
  process.env.METRICS_PORT = "0";
  assert.equal(loadConfig().metricsPort, 0);
  process.env.METRICS_PORT = "70000";
  assert.throws(() => loadConfig(), /METRICS_PORT/);
  process.env.METRICS_PORT = "8788";

  process.env.METRICS_HOST = "bad host";
  assert.throws(() => loadConfig(), /METRICS_HOST/);
  delete process.env.METRICS_HOST;

  process.env.RETRY_BASE_MS = "5000";
  process.env.RETRY_MAX_MS = "1000";
  assert.throws(() => loadConfig(), /RETRY_MAX_MS/);
  delete process.env.RETRY_BASE_MS;
  delete process.env.RETRY_MAX_MS;

  for (const key of KEYS) delete process.env[key];
});

test("keeper config rejects invalid secret shapes without logging them", () => {
  process.env.CONTRACT_ID = "CFAKE";
  process.env.KEEPER_SECRET = "not-a-secret";
  assert.throws(() => loadConfig(), /KEEPER_SECRET/);
  for (const key of KEYS) delete process.env[key];
});
