import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ChargeOutcome,
  keypairSigner,
  outcomeLabel,
  SubStreamClient,
} from "@substream/sdk";

const flags = new Set(process.argv.slice(2));
const once = flags.has("--once");
const dryRun = flags.has("--dry-run") || process.env.DRY_RUN === "1";

interface KeeperConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  secret: string;
  pollIntervalMs: number;
  maxSubscriptions: number;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function loadConfig(): KeeperConfig {
  return {
    contractId: requireEnv("CONTRACT_ID"),
    rpcUrl:
      process.env.RPC_URL?.trim() || "https://soroban-testnet.stellar.org",
    networkPassphrase:
      process.env.NETWORK_PASSPHRASE?.trim() ||
      "Test SDF Network ; September 2015",
    secret: requireEnv("KEEPER_SECRET"),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? "30000"),
    maxSubscriptions: Number(process.env.MAX_SUBSCRIPTIONS ?? "200"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(`[keeper ${new Date().toISOString()}] ${message}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const keypair = Keypair.fromSecret(config.secret);
  const source = keypair.publicKey();

  const client = new SubStreamClient({
    contractId: config.contractId,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
  });
  const signer = keypairSigner(keypair);

  log(`contract ${config.contractId}`);
  log(`source ${source}`);

  if (dryRun && !once) {
    log("dry-run enabled; charges will be logged but not submitted");
  }

  let stopping = false;
  process.on("SIGINT", () => {
    log("SIGINT received, finishing current tick");
    stopping = true;
  });
  process.on("SIGTERM", () => {
    log("SIGTERM received, finishing current tick");
    stopping = true;
  });

  while (!stopping) {
    try {
      const due = await client.getDueSubscriptions(
        source,
        config.maxSubscriptions,
      );

      if (due.length === 0) {
        log("no subscriptions due");
      } else {
        log(`${due.length} subscription(s) due`);
      }

      for (const subscription of due) {
        if (stopping) break;

        if (dryRun) {
          log(
            `[dry-run] would charge #${subscription.id} ` +
              `(plan #${subscription.planId}, balance ${subscription.balance})`,
          );
          continue;
        }

        try {
          const { hash, outcome } = await client.charge({
            subscriptionId: subscription.id,
            source,
            signer,
          });

          const detail = outcomeLabel(outcome);
          log(
            `charge #${subscription.id} (plan #${subscription.planId}) -> ` +
              `${detail} [${hash}]`,
          );

          if (
            outcome !== ChargeOutcome.Charged &&
            outcome !== ChargeOutcome.Cancelled
          ) {
            log(
              `charge #${subscription.id} did not settle; it will be ` +
                "retried on the next tick",
            );
          }
        } catch (error) {
          log(
            `charge #${subscription.id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      log(
        `tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (once) break;
    await sleep(config.pollIntervalMs);
  }

  log("stopped");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
