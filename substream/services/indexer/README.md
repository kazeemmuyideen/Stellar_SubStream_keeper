# SubStream event indexer

The indexer turns SubStream's on-chain contract events into a queryable activity
history. The contract keeps only current state, so the dApp's Activity tab uses
this service for the full sequence of `subscribe`, `topped_up`, `charged`,
`pay_fail`, `cancelled`, and plan events. The service is read-only: it holds no
keys and submits no transactions.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `CONTRACT_ID` | Deployed SubStream contract (`C...`) | required |
| `RPC_URL` | Soroban RPC endpoint | testnet |
| `PORT` | HTTP API port | `8787` |
| `POLL_INTERVAL_MS` | Delay between polls | `15000` |
| `STATE_FILE` | JSON state file | `./data/events.json` |
| `START_LEDGER` | First ledger to scan on a fresh state file | latest − `LOOKBACK_LEDGERS` |
| `LOOKBACK_LEDGERS` | Initial lookback when no `START_LEDGER` is set | `10000` |
| `MAX_EVENTS` | Newest events retained | `5000` |
| `PAGE_SIZE` | Events per RPC page (capped at 1000) | `200` |
| `MAX_PAGES_PER_TICK` | Pages fetched per poll | `10` |

Set these in `services/indexer/.env` (gitignored). Only `CONTRACT_ID` is
required.

## Run it

```bash
npm run indexer:once   # one poll, then exit (useful for a smoke test)
npm run indexer        # continuous polling + HTTP API
```

The first poll starts near the head of the chain (or at `START_LEDGER`) and
walks forward with the RPC cursor. Subsequent polls resume from the saved
cursor. State is written atomically to `STATE_FILE`, so the indexer can be
restarted without losing progress.

## HTTP API

All responses are JSON with permissive CORS headers.

| Endpoint | Description |
| --- | --- |
| `GET /events` | Newest events, optionally filtered |
| `GET /health` | Service status, contract id, last ledger, event count |
| `GET /stats` | Retained event counts by kind |
| `GET /metrics` | Network metrics; add `merchant=G...` for merchant metrics |

`GET /events` accepts `subscriber`, `subscriptionId`, and `limit` (1–500,
default 100) query parameters:

```bash
curl 'http://localhost:8787/events?subscriber=G...&limit=50'
```

Each event has a stable RPC `id`, the event `kind`, optional `subscriptionId`,
`planId`, `subscriber`, `merchant`, `token`, `amount`, `balance`, `nextCharge`,
and `reason`, plus `txHash`, `ledger`, and Unix-second `timestamp`. Base-unit
amounts are strings so they survive JSON serialization.

`GET /metrics` returns cumulative counters derived from contract events:

```bash
curl 'http://localhost:8787/metrics'
curl 'http://localhost:8787/metrics?merchant=G...'
```

The response includes network-wide plan, subscription, charge, failure, and
cancellation counts, settled and refunded totals grouped by SAC token, and the
bounds of the retained event window. A valid `merchant` parameter adds that
merchant's counters plus a per-plan breakdown. Invalid merchant addresses are
rejected with HTTP 400. Tokens that cannot be resolved from an indexed
`plan_new` event are reported under `unknown`.

## DApp integration

Set `VITE_INDEXER_URL` in `apps/web/.env` (for example
`http://localhost:8787`). When the API is reachable, the Activity tab shows the
indexed history with links to the transactions, the landing cards show public
charge metrics, and the Merchant tab shows merchant and per-plan analytics. If
it is not configured or is unavailable, the tab falls back to the start and
most recent charge derived from current contract state.

## Limitations

- Soroban RPC only serves events inside its retention window. Point
  `START_LEDGER` at deployment time to capture older history.
- The state file is a local cache, not a durable database. Back it up or point
  at persistent storage for a production deployment.
- A missed poll is retried from the last cursor; events are deduplicated by
  their RPC event id.
- Metrics are cumulative since the indexer first observed the events and are
  persisted with the state file. A persisted high-water ledger/event id prevents
  a re-anchor from double-counting events that have already aged out of the
  retained cache. They are not an audited accounting ledger; use contract state
  and transaction links for settlement disputes.
- Re-anchoring keeps previously computed metrics and retains the newest known
  ledger in `/metrics`, but subscriptions first seen after a gap cannot be
  attributed to an earlier plan event.
- The dApp allows a larger body for `/metrics` than for `/events`, and rejects
  payloads with more than 100 tokens per scope or 100 plans per merchant. Larger
  deployments should page or prune the response.
