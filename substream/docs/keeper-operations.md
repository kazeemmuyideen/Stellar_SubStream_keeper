# SubStream keeper operations runbook

The keeper is an unprivileged, permissionless settlement worker. It scans
subscriptions and submits `charge` when a cycle is due. It does not hold merchant
funds and it cannot change plan terms.

## Configuration

Copy [`../services/keeper/.env.example`](../services/keeper/.env.example) to
`services/keeper/.env` and set at minimum:

- `CONTRACT_ID` — the deployed SubStream contract (see
  [`../deployments/testnet.json`](../deployments/testnet.json)).
- `KEEPER_SECRET` — a dedicated, minimally funded Stellar secret key. Never
  commit it and never reuse the deployer key.
- `RPC_URL` and `NETWORK_PASSPHRASE` — keep `ALLOW_HTTP` unset except for a
  trusted local RPC endpoint.
- `METRICS_HOST=127.0.0.1` and `METRICS_PORT=8788` for local observation.

The helper `npm run keeper:configure` writes this file interactively. Validate
safe modes before starting a long-running process:

```bash
cd substream
npm run keeper:dry-run   # logs charges without submitting them
npm run keeper:once      # one real polling tick
npm run keeper           # continuous service
```

`--dry-run` and `DRY_RUN=1` are equivalent. A dry run still reads chain state
and emits `keeper_dry_runs_total`; it never spends fees.

## Health and metrics

The keeper exposes two loopback endpoints:

- `GET /health` → `{ "ok": true, "startedAt": ..., "pid": ... }`
- `GET /metrics` → Prometheus text, including
  `keeper_consecutive_failures`, `keeper_last_success_time_seconds`,
  `keeper_due_found_total`, `keeper_charge_attempts_total`,
  `keeper_charge_failures_total`, and outcome counters labelled by result.

Keep `/metrics` on loopback or behind an authenticated reverse proxy. It does
not expose secrets, but it does reveal operational activity.

## Local monitoring stack

[`../monitoring/docker-compose.yml`](../monitoring/docker-compose.yml) starts the
keeper, Prometheus, and Grafana together:

```bash
cd substream/monitoring
export GRAFANA_ADMIN_PASSWORD='choose-a-local-password'
docker compose up -d --build
```

- Prometheus: http://127.0.0.1:9090
- Grafana: http://127.0.0.1:3000 (`admin` / the password you set)

The bundled dashboard is provisioned automatically from
[`grafana/dashboards/substream-keeper.json`](../monitoring/grafana/dashboards/substream-keeper.json).
Alerts live in [`../monitoring/alerts.yml`](../monitoring/alerts.yml):

| Alert | Meaning | First response |
| --- | --- | --- |
| `KeeperScrapeDown` | Metrics endpoint is unreachable | Check container status and `METRICS_HOST` |
| `KeeperTicksFailing` | Three consecutive failed ticks | Check RPC URL, rate limits, and logs |
| `KeeperNoSuccessfulTick` | No successful tick for 15 minutes | Verify the process is alive and not stuck on RPC |
| `KeeperChargeFailures` | More than five thrown charge attempts in 15 minutes | Inspect outcome counters and contract state |

Charging is permissionless, so a stalled keeper does not freeze subscriptions;
another operator or the **Keeper** tab in the dApp can settle due cycles.

## Container images

The keeper and indexer images can be built locally from `substream/`:

```bash
docker build -f services/keeper/Dockerfile -t substream-keeper .
docker build -f services/indexer/Dockerfile -t substream-indexer .
```

`.github/workflows/publish-images.yml` publishes both images to GHCR on `v*`
tags. It requires `packages: write`; no long-lived registry token is committed.

## Incident checklist

1. Confirm the alert against `/health`, `/metrics`, and recent logs.
2. Run `npm run keeper:once` from a clean shell to reproduce the failure.
3. If RPC is unhealthy, switch to a healthy endpoint and restart; backoff is
   bounded by `RETRY_BASE_MS` and `RETRY_MAX_MS`.
4. If a funded key is suspected exposed, stop the keeper, create a new dedicated
   key, update `KEEPER_SECRET`, and fund only the fee budget. The contract has no
   keeper admin role, so no on-chain ownership transfer is needed.
5. Record the incident and outcome in the deployment log.
