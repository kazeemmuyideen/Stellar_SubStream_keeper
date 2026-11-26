# SubStream keeper

The keeper is an optional bot that polls for due subscriptions and submits
`charge` transactions. Charging is permissionless, so running it is never
required to use SubStream.

## What it needs

| Variable | Meaning |
| --- | --- |
| `CONTRACT_ID` | Deployed SubStream contract (`C...`) |
| `KEEPER_SECRET` | Secret key (`S...`) of a funded Stellar account that pays fees |
| `RPC_URL` | Soroban RPC endpoint; defaults to testnet |
| `NETWORK_PASSPHRASE` | Network passphrase; defaults to testnet |
| `POLL_INTERVAL_MS` | Delay between checks (default `30000`) |
| `MAX_SUBSCRIPTIONS` | Maximum subscriptions scanned per pass |
| `DRY_RUN` | `1` logs charges without submitting them |
| `METRICS_HOST` | Metrics bind host; defaults to loopback (`127.0.0.1`) |
| `METRICS_PORT` | Metrics port; default `8788`, set `0` to disable |
| `RETRY_BASE_MS` | Base delay for failed-tick backoff (default `1000`) |
| `RETRY_MAX_MS` | Maximum failed-tick backoff delay (default `60000`) |

## Configure it automatically

From the repository root:

```bash
./scripts/configure-keeper.sh
```

This reads the contract ID from `apps/web/.env`, copies the secret key of the
local `substream-deployer` identity into `.env`, and restricts the file to your
user. It never prints the secret.

## Run it

```bash
npm run keeper:once      # one pass, then exit
npm run keeper:dry-run   # one pass, log only
npm run keeper           # continuous loop; Ctrl+C to stop
```

`no subscriptions due` means the read path is healthy and nothing needs
charging yet.

## Metrics and retries

With the default settings, a running keeper serves:

- `GET http://127.0.0.1:8788/health` — JSON health and tick counters.
- `GET http://127.0.0.1:8788/metrics` — Prometheus text exposition.

`METRICS_PORT=0` disables the endpoint, which is useful for one-shot jobs and
locked-down hosts. Keep it bound to loopback unless you put an authenticated
reverse proxy in front of it. The endpoint never returns the keeper secret.

A failed polling tick uses bounded exponential backoff with jitter:
`RETRY_BASE_MS * 2^(consecutive_failures - 1)`, capped at `RETRY_MAX_MS`, then
returns to the normal `POLL_INTERVAL_MS` after a successful tick. Individual
charge errors are counted and retried on the next tick. Charging is
permissionless, so a missed keeper tick never blocks subscribers or merchants.

Sample output:

```text
# HELP keeper_ticks_total Completed keeper ticks.
# TYPE keeper_ticks_total counter
keeper_ticks_total 42
# HELP keeper_tick_failures_total Failed keeper ticks.
# TYPE keeper_tick_failures_total counter
keeper_tick_failures_total 1
# HELP keeper_charge_outcomes_total Charge outcomes returned by the contract.
# TYPE keeper_charge_outcomes_total counter
keeper_charge_outcomes_total{outcome="charged"} 17
```

The keeper account only needs XLM for network fees. Subscriber funds stay in
contract escrow and are never held by the keeper. On testnet, top up the keeper
account with:

```bash
curl "https://friendbot.stellar.org?addr=G...keeper-public-key..."
```
