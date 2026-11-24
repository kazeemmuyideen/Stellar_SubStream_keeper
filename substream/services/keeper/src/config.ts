export interface KeeperConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  secret: string;
  allowHttp: boolean;
  pollIntervalMs: number;
  maxSubscriptions: number;
}

export function requireEnv(name: string): string {
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

export function loadConfig(): KeeperConfig {
  const secret = requireEnv("KEEPER_SECRET");
  if (!/^S[A-Z2-7]{55}$/.test(secret)) {
    throw new Error("KEEPER_SECRET is not a valid Stellar secret key");
  }

  return {
    contractId: requireEnv("CONTRACT_ID"),
    rpcUrl:
      process.env.RPC_URL?.trim() || "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.NETWORK_PASSPHRASE?.trim() ||
      "Test SDF Network ; September 2015",
    secret,
    allowHttp: process.env.ALLOW_HTTP?.trim() === "1",
    pollIntervalMs: boundedInt("POLL_INTERVAL_MS", 30_000, 1_000, 86_400_000),
    maxSubscriptions: boundedInt("MAX_SUBSCRIPTIONS", 200, 1, 500),
  };
}
