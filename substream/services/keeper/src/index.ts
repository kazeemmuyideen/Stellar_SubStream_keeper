import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ChargeOutcome,
  keypairSigner,
  outcomeLabel,
  SubStreamClient,
} from "@substream/sdk";
import { loadConfig } from "./config";
import { backoffDelay, KeeperMetrics } from "./metrics";
import { startMetricsServer } from "./metrics-server";

const flags = new Set(process.argv.slice(2));
const once = flags.has("--once");
const dryRun = flags.has("--dry-run") || process.env.DRY_RUN === "1";

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
  const metrics = new KeeperMetrics();

  const client = new SubStreamClient({
    contractId: config.contractId,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
    allowHttp: config.allowHttp,
  });
  const signer = keypairSigner(keypair);

  log(`contract ${config.contractId}`);
  log(`source ${source}`);

  if (dryRun && !once) {
    log("dry-run enabled; charges will be logged but not submitted");
  }

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

  const server =
    !once && config.metricsPort > 0
      ? await startMetricsServer(metrics, {
          host: config.metricsHost,
          port: config.metricsPort,
        })
      : undefined;
  if (server) {
    log(`metrics at http://${config.metricsHost}:${config.metricsPort}/metrics`);
  }

  try {
    while (!stopping) {
      metrics.tickStarted();
      try {
        const due = await client.getDueSubscriptions(
          source,
          config.maxSubscriptions,
        );

        metrics.tickSucceeded(due.length);
        if (due.length === 0) {
          log("no subscriptions due");
        } else {
          log(`${due.length} subscription(s) due`);
        }

        for (const subscription of due) {
          if (stopping) break;

          if (dryRun) {
            metrics.dryRun();
            log(
              `[dry-run] would charge #${subscription.id} ` +
                `(plan #${subscription.planId}, balance ${subscription.balance})`,
            );
            continue;
          }

          metrics.chargeAttempted();
          try {
            const { hash, outcome } = await client.charge({
              subscriptionId: subscription.id,
              source,
              signer,
            });

            metrics.chargeSucceeded(outcomeLabel(outcome));
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
            metrics.chargeFailed();
            log(
              `charge #${subscription.id} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      } catch (error) {
        metrics.tickFailed();
        log(
          `tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (once) break;

      const failures = metrics.snapshot().consecutiveFailures;
      const delay =
        failures > 0
          ? backoffDelay(failures, config.retryBaseMs, config.retryMaxMs)
          : config.pollIntervalMs;
      if (failures > 0) {
        log(`${failures} consecutive failure(s); retrying in ${delay}ms`);
      }
      await sleep(delay);
    }
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (forceExit) clearTimeout(forceExit);
    log(metrics.summaryLine());
    log("stopped");
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
