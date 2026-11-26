import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";

import { KeeperMetrics } from "./metrics";
import { startMetricsServer } from "./metrics-server";

test("keeper exposes JSON health and Prometheus metrics", async (t) => {
  const metrics = new KeeperMetrics();
  metrics.tickStarted();
  metrics.tickSucceeded(1);
  metrics.chargeAttempted();
  metrics.chargeSucceeded("Charged");

  const server: Server = await startMetricsServer(metrics, {
    host: "127.0.0.1",
    port: 0,
  });
  t.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get("content-type") ?? "", /application\/json/);
  const body = (await health.json()) as { ok: boolean; ticks: number };
  assert.equal(body.ok, true);
  assert.equal(body.ticks, 1);

  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  const text = await response.text();
  assert.match(text, /keeper_ticks_total 1/);
  assert.match(text, /keeper_charge_outcomes_total\{outcome="charged"\} 1/);

  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const post = await fetch(`${base}/metrics`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});
