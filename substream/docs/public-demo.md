# Public SubStream demo deployment

This is the deployment recipe for a public, HTTPS demo of the dApp and indexer.
The configuration is committed; the URLs become real only after you deploy it
to an account you control.

## What is already prepared

- Fresh hardened testnet contract:
  `CBLX5BM4OUDH47QBBAJLCRF5YSBTEWBVDQISJL2LQQGA3CPWKMQOYVMS`
- Reproducible WASM hash:
  `159c0f098e8ca4068709b50081731e175f79327166928679c7b9f2969e093af7`
- Public demo plan: plan `2`, 1 XLM every 30 days, one-day grace period.
- Render Blueprint: [`../render.yaml`](../render.yaml)
- Static build env template:
  [`../apps/web/.env.production.example`](../apps/web/.env.production.example)
- Indexer env template:
  [`../services/indexer/.env.production.example`](../services/indexer/.env.production.example)
- On-chain evidence and transaction links:
  [`../deployments/testnet.json`](../deployments/testnet.json)

The old testnet contract is intentionally left running its original WASM. The
new contract is separate because the hardened `Subscription` struct is not
storage-compatible with the old records.

## Deploy with Render

1. Push this branch to GitHub.
2. In Render, choose **Blueprint → New Blueprint Instance** and point it at the
   repository. Select `substream/render.yaml` when asked for the Blueprint path.
3. Name the stack and deploy. Render creates:
   - `substream-indexer`: Node web service with a 1 GB persistent disk.
   - `substream-dapp`: static site whose `VITE_INDEXER_URL` is automatically set
     to the indexer service URL.
4. Wait for both services to report a successful deploy. The indexer plan uses
   the paid `starter` tier because the cumulative metrics need a persistent
   disk. If you use a free service without a disk, the retained activity window
   can be rebuilt from RPC but lifetime counters reset on restart.
5. Copy the two live URLs into the **Demo** fields of
   [`scf-application.md`](scf-application.md).

## Verify the deployment

Replace the hosts with your Render URLs:

```bash
curl https://<indexer-host>/health
curl 'https://<indexer-host>/events?limit=10'
curl https://<indexer-host>/metrics
curl 'https://<indexer-host>/metrics?merchant=GBZZVBFJTX23YRYGYID6P4YHESDHYZFWKOBPMQSFKHLBHJZMHTXDIFPB'
```

Expected `/health` shape:

```json
{
  "ok": true,
  "contractId": "CBLX5BM4OUDH47QBBAJLCRF5YSBTEWBVDQISJL2LQQGA3CPWKMQOYVMS",
  "lastLedger": 5936155,
  "events": 5
}
```

`lastLedger` advances as the indexer polls. With `START_LEDGER=5936155`, the
fresh lifecycle events from the demo run are picked up immediately. The API
contract is in [`indexer-openapi.json`](indexer-openapi.json).

Then open the dApp URL:

1. Connect Freighter on Testnet.
2. Follow **Guided demo**: create a 10-second plan, subscribe with two cycles,
   wait for the countdown, charge, then cancel and inspect the refund link.
3. Open **Subscriptions** to check status filters, search, escrow totals, and
   the subscriptions-to-my-plans table.
4. Open **Merchant** to confirm cumulative metrics populate after the indexer
   catches up. If the indexer is unreachable, the dApp still reads contract
   state from RPC and labels the metrics as offline.

## Other HTTPS hosts

The Blueprint is a reference, not a requirement. Any host works if it:

- serves the Vite build from `apps/web/dist` with `VITE_*` set at **build** time;
- serves the indexer with a persistent `STATE_FILE` and TLS;
- keeps `ALLOW_HTTP` unset; and
- keeps keeper metrics on loopback or behind an authenticated proxy.

See [`hosting.md`](hosting.md) for the general host-agnostic instructions.
