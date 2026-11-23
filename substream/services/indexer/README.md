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
| `GET /stats` | Event counts by kind |

`GET /events` accepts `subscriber`, `subscriptionId`, and `limit` (1–500,
default 100) query parameters:

```bash
curl 'http://localhost:8787/events?subscriber=G...&limit=50'
```

Each event has a stable RPC `id`, the event `kind`, optional `subscriptionId`,
`planId`, `subscriber`, `amount`, `balance`, `nextCharge`, and `reason`, plus
`txHash`, `ledger`, and Unix-second `timestamp`. Base-unit amounts are strings
so they survive JSON serialization.

## DApp integration

Set `VITE_INDEXER_URL` in `apps/web/.env` (for example
`http://localhost:8787`). When the API is reachable, the Activity tab shows the
indexed history with links to the transactions. If it is not configured or is
unavailable, the tab falls back to the start and most recent charge derived
from current contract state.

## Limitations

- Soroban RPC only serves events inside its retention window. Point
  `START_LEDGER` at deployment time to capture older history.
- The state file is a local cache, not a durable database. Back it up or point
  at persistent storage for a production deployment.
- A missed poll is retried from the last cursor; events are deduplicated by
  their RPC event id.
