import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { rpc } from "@stellar/stellar-sdk";
import type { IndexedEvent } from "@substream/sdk";
import { loadConfig } from "./config";
import { parseEvent } from "./events";
import { EventStore } from "./store";

const once = process.argv.includes("--once");

function log(message: string): void {
  console.log(`[indexer ${new Date().toISOString()}] ${message}`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const stellar = new rpc.Server(config.rpcUrl);
  const store = new EventStore(config.stateFile, config.maxEvents);
  await store.load();

  const latest = await stellar.getLatestLedger();
  const firstLedger =
    config.startLedger ?? Math.max(1, latest.sequence - config.lookbackLedgers);
  store.initialize(firstLedger);

  log(`contract ${config.contractId}`);
  log(`rpc ${config.rpcUrl}`);
  log(
    `state ${config.stateFile} (${store.size} event(s), ` +
      `cursor ${store.cursor ?? "none"}, from ledger ${store.startLedger})`,
  );

  const filters: rpc.Api.EventFilter[] = [
    { type: "contract", contractIds: [config.contractId] },
  ];

  async function collect(
    startCursor: string | undefined,
  ): Promise<{ rawEvents: rpc.Api.EventResponse[]; cursor?: string }> {
    const rawEvents: rpc.Api.EventResponse[] = [];
    let cursor = startCursor;

    for (let page = 0; page < config.maxPagesPerTick; page += 1) {
      const request: rpc.Api.GetEventsRequest = cursor
        ? { filters, cursor, limit: config.pageSize }
        : { filters, startLedger: store.startLedger!, limit: config.pageSize };

      const response = await stellar.getEvents(request);
      rawEvents.push(...response.events);
      cursor = response.cursor || cursor;
      if (response.events.length < config.pageSize) break;
    }

    return { rawEvents, cursor };
  }

  async function poll(): Promise<number> {
    let result;
    try {
      result = await collect(store.cursor);
    } catch (error) {
      // A saved cursor eventually falls outside the RPC retention window.
      // Re-anchor near the head instead of failing every subsequent tick.
      if (!store.cursor) throw error;
      const head = await stellar.getLatestLedger();
      const startLedger = Math.max(1, head.sequence - config.lookbackLedgers);
      log(`cursor out of range; re-anchoring at ledger ${startLedger}`);
      store.reanchor(startLedger);
      result = await collect(undefined);
    }

    const decoded = result.rawEvents
      .map(parseEvent)
      .filter((event): event is IndexedEvent => event !== null);
    const head = await stellar.getLatestLedger();
    const added = store.add(decoded, result.cursor ?? "", head.sequence);
    await store.persist();
    return added;
  }

  if (once) {
    const added = await poll();
    log(`indexed ${added} new event(s); ${store.size} total`);
    return;
  }

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://localhost:${config.port}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    if (url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        contractId: config.contractId,
        lastLedger: store.lastLedger,
        events: store.size,
      });
      return;
    }

    if (url.pathname === "/events") {
      const rawLimit = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(1, Math.floor(rawLimit)), 500)
        : 100;
      sendJson(response, 200, {
        events: store.query({
          subscriber: url.searchParams.get("subscriber") ?? undefined,
          subscriptionId:
            url.searchParams.get("subscriptionId") ?? undefined,
          limit,
        }),
        cursor: store.cursor ?? null,
        lastLedger: store.lastLedger,
        indexed: store.size,
      });
      return;
    }

    if (url.pathname === "/stats") {
      const byKind: Record<string, number> = {};
      for (const event of store.query({ limit: config.maxEvents })) {
        byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
      }
      sendJson(response, 200, {
        events: store.size,
        lastLedger: store.lastLedger,
        byKind,
      });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, () => {
      log(`HTTP API listening on http://localhost:${config.port}`);
      resolve();
    });
  });

  let stopping = false;
  const stop = (signal: string) => {
    log(`${signal} received, finishing current tick`);
    stopping = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    try {
      const added = await poll();
      if (added > 0) log(`indexed ${added} new event(s); ${store.size} total`);
    } catch (error) {
      log(
        `poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  log("stopped");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
