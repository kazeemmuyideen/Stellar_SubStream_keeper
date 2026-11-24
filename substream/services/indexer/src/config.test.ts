import assert from "node:assert/strict";
import test from "node:test";

import { boundedInt, loadConfig } from "./config";

test("boundedInt rejects values that would spin a poll loop", () => {
  process.env.TEST_POLL_MS = "0";
  assert.throws(() => boundedInt("TEST_POLL_MS", 1_000, 1_000, 60_000), /between/);

  process.env.TEST_POLL_MS = "-1";
  assert.throws(() => boundedInt("TEST_POLL_MS", 1_000, 1_000, 60_000), /between/);

  process.env.TEST_POLL_MS = "9999999999";
  assert.throws(() => boundedInt("TEST_POLL_MS", 1_000, 1_000, 60_000), /between/);

  process.env.TEST_POLL_MS = "15000";
  assert.equal(boundedInt("TEST_POLL_MS", 1_000, 1_000, 60_000), 15_000);
  delete process.env.TEST_POLL_MS;
});

test("indexer config validates numeric environment values", () => {
  process.env.CONTRACT_ID = "CFAKE";
  process.env.PAGE_SIZE = "0";
  assert.throws(() => loadConfig(), /PAGE_SIZE/);

  process.env.PAGE_SIZE = "200";
  process.env.MAX_PAGES_PER_TICK = "not-a-number";
  assert.throws(() => loadConfig(), /MAX_PAGES_PER_TICK/);

  delete process.env.CONTRACT_ID;
  delete process.env.PAGE_SIZE;
  delete process.env.MAX_PAGES_PER_TICK;
});
