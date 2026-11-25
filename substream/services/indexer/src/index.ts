import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { rpc } from "@stellar/stellar-sdk";
import type { IndexedEvent } from "@substream/sdk";
import { loadConfig } from "./config";
import { parseEvent } from "./events";
import { handleIndexerRequest } from "./http";
import { collectPages, isCursorOutOfRangeError, withRetry } from "./poll";
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
  const stellar = new rpc.Server(config.rpcUrl, {
    allowHttp: config.allowHttp,
    timeout: config.rpcTimeoutMs,
  });
  const store = new EventStore(config.stateFile, config.maxEvents);
  if (await store.load()) {
    log(`corrupt state file quarantined; starting from a fresh index`);
  }

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

  async function collect(startCursor: string | undefined) {
    return collectPages(
      async (cursor) => {
        const request: rpc.Api.GetEventsRequest = cursor
          ? { filters, cursor, limit: config.pageSize }
          : { filters, startLedger: store.startLedger!, limit: config.pageSize };

        return withRetry(
          () => stellar.getEvents(request),
          3,
          (attempt, message) =>
            log(`getEvents attempt ${attempt} failed; retrying: ${message}`),
        );
      },
      {
        startCursor,
        pageSize: config.pageSize,
        maxPages: config.maxPagesPerTick,
        onStalled: () =>
          log("RPC returned a full page without an advancing cursor; stopping"),
      },
    );
  }

  async function poll(): Promise<number> {
    let result;
    try {
      result = await collect(store.cursor);
    } catch (error) {
      // Only a cursor-specific failure is safe to re-anchor on. Any other
      // error keeps the old cursor so the next tick does not skip events.
      if (!store.cursor || !isCursorOutOfRangeError(error)) throw error;
      const head = await stellar.getLatestLedger();
      const startLedger = Math.max(1, head.sequence - config.lookbackLedgers);
      log(
        `cursor out of range; re-anchoring at ledger ${startLedger} ` +
          `(was ${store.cursor})`,
      );
      store.reanchor(startLedger);
      result = await collect(undefined);
    }

    const decoded = result.events
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
    const result = handleIndexerRequest(
      request.method,
      url,
      store,
      config,
    );

    if (request.method !== "GET" && request.method !== "OPTIONS") {
      request.resume();
    }

    if (result === null) {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      response.end();
      return;
    }

    sendJson(response, result.status, result.body);
  });

  httpServer.requestTimeout = 10_000;
  httpServer.headersTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, () => {
      log(`HTTP API listening on http://localhost:${config.port}`);
      resolve();
    });
  });

  let stopping = false;
  let forceExit: NodeJS.Timeout | undefined;
  const stop = (signal: string) => {
    log(`${signal} received, finishing current tick`);
    stopping = true;
    if (!forceExit) {
      forceExit = setTimeout(() => {
        log("graceful shutdown timed out; exiting");
        process.exit(1);
      }, 30_000);
      forceExit.unref();
    }
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

  if (forceExit) clearTimeout(forceExit);
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  log("stopped");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
