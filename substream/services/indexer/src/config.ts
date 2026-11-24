import type { EventKindValue } from "@substream/sdk";

export interface IndexerConfig {
  contractId: string;
  rpcUrl: string;
  rpcTimeoutMs: number;
  allowHttp: boolean;
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

export function boundedInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
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
    rpcTimeoutMs: boundedInt("RPC_TIMEOUT_MS", 15_000, 1_000, 60_000),
    allowHttp: process.env.ALLOW_HTTP?.trim() === "1",
    port: boundedInt("PORT", 8787, 1, 65_535),
    pollIntervalMs: boundedInt("POLL_INTERVAL_MS", 15_000, 1_000, 86_400_000),
    stateFile: process.env.STATE_FILE?.trim() || "./data/events.json",
    startLedger: parsedStart,
    lookbackLedgers: boundedInt("LOOKBACK_LEDGERS", 10_000, 1, 1_000_000),
    maxEvents: boundedInt("MAX_EVENTS", 5_000, 1, 100_000),
    pageSize: boundedInt("PAGE_SIZE", 200, 1, 1_000),
    maxPagesPerTick: boundedInt("MAX_PAGES_PER_TICK", 10, 1, 100),
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
