# Hosting the public SubStream stack

This guide deploys the dApp, indexer, and keeper without changing the contract.
It does **not** claim that public instances are already live; fill in the URLs
in [`scf-application.md`](scf-application.md) only after these steps succeed.

For the fastest reproducible public demo, use the Render Blueprint in
[`public-demo.md`](public-demo.md) and [`../render.yaml`](../render.yaml). The
steps below are the host-agnostic version.

## 1. Build the static dApp

The Vite build inlines `VITE_*` values, so set them at build time:

```bash
cd substream
cp apps/web/.env.example apps/web/.env
# Fill VITE_CONTRACT_ID, VITE_TOKEN_ADDRESS, and VITE_INDEXER_URL.
npm ci
npm run build -w @substream/web
```

Publish `apps/web/dist/` to any static host. If the dApp is served over HTTPS,
`VITE_INDEXER_URL` must also be HTTPS to avoid mixed-content blocking. The dApp
degrades gracefully when the indexer is unavailable: discovery and wallet
actions still work from RPC.

## 2. Run the indexer with persistent storage

```bash
cp services/indexer/.env.example services/indexer/.env
# Set CONTRACT_ID and, ideally, START_LEDGER to the deployment ledger.
docker compose up -d indexer
```

The indexer writes cumulative metrics to `STATE_FILE` (default
`./data/events.json`). The Compose file mounts a named volume at `/app/data`;
back that volume up on a schedule. Losing it resets lifetime counters, while
the retained `/events` window can be rebuilt from the chain.

Expose the indexer through a TLS reverse proxy at a public path such as
`https://api.example.com/`. Required routes are `/health`, `/events`, `/stats`,
and `/metrics`; the API contract is in [`indexer-openapi.json`](indexer-openapi.json).
Keep `ALLOW_HTTP` unset for public RPC endpoints.

## 3. Run the keeper

```bash
cp services/keeper/.env.example services/keeper/.env
# Fill CONTRACT_ID and KEEPER_SECRET. Use a dedicated, minimally funded account.
docker compose up -d keeper
```

The keeper metrics endpoint binds to loopback by default and is published only
on `127.0.0.1:8788`. Do not expose it directly to the internet, and never put
`KEEPER_SECRET` in a Docker image or `VITE_*` variable. For public status,
scrape the loopback endpoint from a local agent or place an authenticated
reverse proxy in front of it.

## 4. Verify

```bash
curl https://api.example.com/health
curl 'https://api.example.com/events?limit=10'
curl https://api.example.com/metrics
curl 'https://api.example.com/metrics?merchant=G...'
curl http://127.0.0.1:8788/metrics
```

A fresh indexer can take several poll intervals to catch up. Confirm the dApp
shows activity only after `/health` reports a `lastLedger` at or beyond the
deployment ledger. If RPC retention no longer reaches that ledger, record the
gap rather than presenting reconstructed totals as complete history.

## Container builds without Compose

```bash
cd substream
docker build -f services/indexer/Dockerfile -t substream-indexer .
docker build -f services/keeper/Dockerfile -t substream-keeper .
```
