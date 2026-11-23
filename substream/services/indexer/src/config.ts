import type { EventKindValue } from "@substream/sdk";

export interface IndexerConfig {
  contractId: string;
  rpcUrl: string;
  port: number;
  pollIntervalMs: number;
  stateFile: string;
  startLedger?: number;
  lookbackLedgers: number;
  maxEvents: number;
  pageSize: number;
  maxPagesPerTick: number;
  kinds: Set<EventKindValue>;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): IndexerConfig {
  const startLedger = process.env.START_LEDGER?.trim();
  const parsedStart = startLedger ? Number(startLedger) : undefined;
  if (
    parsedStart !== undefined &&
    (!Number.isSafeInteger(parsedStart) || parsedStart < 1)
  ) {
    throw new Error("START_LEDGER must be a positive integer");
  }

  return {
    contractId: requireEnv("CONTRACT_ID"),
    rpcUrl:
      process.env.RPC_URL?.trim() || "https://soroban-testnet.stellar.org",
    port: positiveInt("PORT", 8787),
    pollIntervalMs: positiveInt("POLL_INTERVAL_MS", 15_000),
    stateFile: process.env.STATE_FILE?.trim() || "./data/events.json",
    startLedger: parsedStart,
    lookbackLedgers: positiveInt("LOOKBACK_LEDGERS", 10_000),
    maxEvents: positiveInt("MAX_EVENTS", 5_000),
    pageSize: Math.min(positiveInt("PAGE_SIZE", 200), 1_000),
    maxPagesPerTick: positiveInt("MAX_PAGES_PER_TICK", 10),
    kinds: new Set<EventKindValue>([
      "plan_new",
      "plan_upd",
      "subscribe",
      "topped_up",
      "charged",
      "pay_fail",
      "cancelled",
    ]),
  };
}
