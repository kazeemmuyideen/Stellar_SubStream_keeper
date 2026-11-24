import assert from "node:assert/strict";
import test from "node:test";

import { scanEnd, SubStreamClient, toChargeOutcome } from "./client";
import { ChargeOutcome } from "./types";

const CONTRACT_ID =
  "CDLDVFKHEZ2RVB3NG4UQA4VPD3TSHV6XMHXMHP2BSGCJ2IIWVTOHGDSG";

test("scanEnd clamps big counts and rejects bad limits", () => {
  assert.equal(scanEnd(3n, 100), 3);
  assert.equal(scanEnd(10_000n, 100), 100);
  assert.equal(scanEnd(10n, 10_000), 10);
  assert.equal(scanEnd(0n, 100), 0);
  assert.throws(() => scanEnd(1n, 0), /positive integer/);
  assert.throws(() => scanEnd(1n, Number.POSITIVE_INFINITY), /positive integer/);
});

test("charge outcomes are validated instead of trusted verbatim", () => {
  assert.equal(toChargeOutcome(0), ChargeOutcome.Charged);
  assert.equal(toChargeOutcome("4"), ChargeOutcome.PlanInactive);
  assert.throws(() => toChargeOutcome(99), /unknown charge outcome/);
  assert.throws(() => toChargeOutcome("not-a-number"), /unknown charge outcome/);
  assert.throws(() => toChargeOutcome(null), /unknown charge outcome/);
  assert.throws(() => toChargeOutcome(""), /unknown charge outcome/);
  assert.throws(() => toChargeOutcome("   "), /unknown charge outcome/);
  assert.throws(() => toChargeOutcome([]), /unknown charge outcome/);
});

test("client rejects unsafe numeric configuration", () => {
  assert.throws(
    () => new SubStreamClient({ contractId: CONTRACT_ID, rpcTimeoutMs: -1 }),
    /rpcTimeoutMs/,
  );
  assert.throws(
    () => new SubStreamClient({ contractId: CONTRACT_ID, maxFee: Number.NaN }),
    /maxFee/,
  );
  assert.throws(
    () => new SubStreamClient({ contractId: CONTRACT_ID, confirmTimeoutMs: 0 }),
    /confirmTimeoutMs/,
  );
});
