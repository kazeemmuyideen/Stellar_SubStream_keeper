# SubStream

**Recurring payments for Stellar, settled by Soroban escrow.**

SubStream is an open-source subscription primitive for Stellar. Subscribers
prepay a number of billing cycles into a Soroban contract. Anyone — a keeper,
the merchant, or the subscriber — can trigger a charge when a cycle is due.
Unused escrow is always refundable to the subscriber.

The repository contains a complete, self-contained implementation: a Soroban
contract, a TypeScript SDK, a React dApp, a permissionless keeper service, and
deployment tooling.

```
                 subscribe / top_up / cancel
   Subscriber ───────────────────────────────┐
        │                                    ▼
        │                          ┌───────────────────┐
        └──── SAC transfer ───────▶│  SubStream        │
                                   │  escrow contract  │
                                   └─────────┬─────────┘
                                             │ charge (permissionless)
                                             ▼
                                   ┌───────────────────┐
                                   │  Merchant account │
                                   └───────────────────┘
                                             ▲
                       keeper / merchant / subscriber
```

## Why this exists

Stellar is excellent at moving value, but it has no native subscription
primitive. The usual workarounds are:

- **Per-cycle approvals.** Token allowances expire, require a wallet signature
  every cycle, and break the moment a user rotates keys or a wallet drops
  support.
- **Custodial billing.** A processor holds the user's funds and takes on
  custody risk. This is exactly what Stellar users should not need.
- **Pull-payment invoices.** Merchants have to chase every renewal manually.

SubStream replaces all three with a small, auditable escrow contract. The
subscriber signs once, prepays N cycles, and can walk away at any time with the
remaining balance.

## What it does

- **Plans** — merchants publish a token, amount per cycle, interval, and grace
  period. Plans can be paused and updated.
- **Snapshot terms** — a subscription captures the plan terms at subscribe
  time, so a merchant cannot unilaterally raise the price of an existing
  subscription.
- **Prepaid escrow** — subscribers deposit N cycles up front, or top up later.
- **Permissionless charging** — `charge` requires no auth. Keepers, merchants,
  and subscribers can all settle due cycles.
- **Grace periods** — a failed charge marks the subscription `PastDue`. If the
  balance is not restored before the grace period ends, the subscription is
  cancelled and the remainder is refunded. A top-up after that deadline
  finalizes the cancellation instead of reviving the subscription.
- **Refunds** — subscriber cancellation instantly returns the unused escrow.
  Merchant cancellation (for a paused plan or a past-due subscription) returns
  funds to the subscriber, never to the merchant.
- **Composability** — any Stellar Asset Contract (SAC) token works, including
  stablecoins and tokenized assets. The contract is a normal Soroban contract
  that other protocols, wallets, and indexers can call.

## Live testnet deployment

A pre-audit beta is deployed on Stellar testnet:

| Network | Contract ID | Explorer |
| --- | --- | --- |
| Testnet | `CBQROANJSSROOEZUZGNRDRUWOWQFZAREE4QLERSTMKVJD2B2T2U6FYMN` | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CBQROANJSSROOEZUZGNRDRUWOWQFZAREE4QLERSTMKVJD2B2T2U6FYMN) |

The deployed WASM is older than the current source: the grace-period, TTL, and
refund hardening described here is source-only until the contract is redeployed.
See [`deployments/testnet.json`](deployments/testnet.json) for the recorded
hashes and the outstanding redeploy step.

The deployment used native XLM as the SAC token. Plan #1 is a live demo plan:
**1 XLM per 30 days with a one-day grace period**. Use the Merchant tab to
create your own plan, or point a plan at a testnet USDC SAC.

The full lifecycle was smoke-tested on this deployment:

| Step | Transaction |
| --- | --- |
| Create plan | [`f9590f9c…`](https://stellar.expert/explorer/testnet/tx/f9590f9c53dff403da59b595b270fe2cfaf9bbad578f86e1055a8dc1c43505c9) |
| Subscribe (2 cycles) | [`8e506f2f…`](https://stellar.expert/explorer/testnet/tx/8e506f2f3aa0a15ed43c74f99eaf31d48a5daccf9764e3d34cb8d67fb10c648b) |
| Charge | [`508a7386…`](https://stellar.expert/explorer/testnet/tx/508a73860133a224a227594f5c2e6a80035437ed3764acdbf70bdc8ff8c92444) |
| Cancel + refund | [`2a8ea660…`](https://stellar.expert/explorer/testnet/tx/2a8ea66032a9b377f4ddbd78590ab88216ffe244c8810f30e458c13499105fff) |

To reproduce the lifecycle yourself against the live contract:

```bash
./scripts/demo.sh --interval 10 --cycles 2
```

The script creates and pauses its own plan, so it does not leave an active demo
plan behind. Transaction links are printed as it runs.

## Repository layout

| Path | Description |
| --- | --- |
| `contracts/substream` | Soroban contract (`lib.rs`) and unit tests (`test.rs`) |
| `packages/sdk` | TypeScript client, signer adapters, typed helpers |
| `apps/web` | React + Vite dApp for subscribers, merchants, and manual keepers |
| `services/keeper` | Background service that settles due subscriptions |
| `services/indexer` | Read-only event indexer and HTTP activity API |
| `deployments/` | Recorded testnet deployment, demo plan, and transaction links |
| `scripts/deploy.sh` | Builds and deploys with the Stellar CLI |
| `scripts/configure-keeper.sh` | Writes the keeper `.env` from a local identity |
| `scripts/demo.sh` | Runs create → subscribe → charge → refund on a live contract |
| `docs/` | Architecture, contract API, demo script, and the SCF application draft |

## Quick start

### Prerequisites

- Rust stable (the repo's `rust-toolchain.toml` installs the `wasm32v1-none`
  target automatically)
- Node.js 20+ and npm
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
  for building and deploying
- [Freighter](https://freighter.app) for the dApp

### Run the contract tests

```bash
cd substream
cargo test
```

### Install and build the TypeScript packages

```bash
npm install
npm run build
```

### Deploy to testnet

```bash
./scripts/deploy.sh testnet
```

The script builds the contract, creates and funds a `substream-deployer`
identity if needed, deploys the contract, and writes `apps/web/.env` with the
new contract ID and the testnet native-token SAC address.

### Run the dApp

```bash
npm run dev
```

Open <http://localhost:5173> and click **Connect Freighter**.

The dApp reads the contract address from `apps/web/.env`, which the deploy
script fills in. You do not need to paste a contract ID anywhere.

### What “connect Freighter on testnet” means

**Freighter** is a browser wallet extension for Stellar, similar to MetaMask for
Ethereum. It holds your keys and asks you to approve transactions.

**Testnet** is Stellar's practice network. It is completely separate from
mainnet, and its XLM has no real value. Contracts and balances on testnet do not
exist on mainnet.

To connect for the first time:

1. Install Freighter from <https://freighter.app> and create (or import) a
   wallet. Write down the recovery phrase.
2. Open the Freighter extension, open its network selector, and choose
   **Testnet**. If it stays on Mainnet, the dApp's transactions will fail.
3. Copy your public key — it starts with `G`.
4. Fund that account with free test XLM from
   [Stellar Lab's account creator](https://laboratory.stellar.org/#account-creator?network=testnet)
   or with:
   ```bash
   curl "https://friendbot.stellar.org?addr=G...your-public-key..."
   ```
5. Reload the dApp, click **Connect Freighter**, and approve the connection in
   the Freighter popup.

Then use the **Merchant** tab to create a plan. Enter the amount in whole units
(for example `1` means 1 XLM); token decimals default to `7`. The token field is
prefilled with the testnet XLM Stellar Asset Contract. Switch to **Market** to
subscribe. Amounts in the contract are stored in stroops (`1 XLM = 10,000,000`),
but the dApp converts them for you.

### Run the keeper (optional)

A **keeper** is a small bot that checks for due subscriptions and submits
`charge` transactions. Charging is permissionless, so a keeper is just a
convenience — the dApp's **Keeper** tab does the same thing manually with your
Freighter wallet.

The keeper signs with a Stellar **secret key** (`S...`) from a funded account.
Configure it once:

```bash
./scripts/configure-keeper.sh
```

That script copies the contract ID from `apps/web/.env`, copies the secret key
of the local `substream-deployer` identity into `services/keeper/.env`, sets the
file to owner-only permissions, and never prints the key. The file is
gitignored.

Then run it:

```bash
npm run keeper:once      # check once, then exit
npm run keeper:dry-run   # check once and log, submit nothing
npm run keeper           # keep checking every 30 seconds; Ctrl+C to stop
```

If the output says `no subscriptions due`, the keeper is working — nothing is
due yet. The keeper account only pays network fees; subscriber money stays in
the contract's escrow. On testnet, fund the keeper account with friendbot if it
runs out of XLM.

To set it up manually instead, copy `services/keeper/.env.example` to
`services/keeper/.env` and fill in `CONTRACT_ID` and `KEEPER_SECRET`.

### Run the activity indexer (optional)

The contract stores current state, not a transaction history. The indexer polls
Soroban RPC for SubStream contract events and serves them through a small
read-only HTTP API, which powers the full Activity history in the dApp.

```bash
cp services/indexer/.env.example services/indexer/.env
# set CONTRACT_ID in services/indexer/.env
npm run indexer:once   # one poll, then exit
npm run indexer        # continuous polling + API on http://localhost:8787
```

Set `VITE_INDEXER_URL=http://localhost:8787` in `apps/web/.env` to enable the
history in the dApp. Without it, the Activity tab falls back to the start and
most recent charge derived from current contract state. See
[`services/indexer/README.md`](services/indexer/README.md) for configuration
and API details.

## Contract API at a glance

| Function | Auth | Purpose |
| --- | --- | --- |
| `create_plan(merchant, token, amount, interval, grace_period)` | merchant | Create a reusable plan |
| `update_plan(merchant, plan_id, amount, interval, grace_period, active)` | merchant | Update future subscriptions and pause/resume |
| `subscribe(subscriber, plan_id, cycles_prepaid)` | subscriber | Deposit N cycles and start a subscription |
| `top_up(subscriber, subscription_id, cycles)` | subscriber | Add escrow |
| `charge(subscription_id)` | none | Settle one due cycle, or mark past due |
| `cancel(subscriber, subscription_id)` | subscriber | Cancel and refund the remainder |
| `cancel_by_merchant(merchant, subscription_id)` | merchant | Cancel a past-due subscription or paused plan |
| `get_plan`, `get_subscription`, `quote`, `is_due` | none | Read helpers |
| `get_plan_count`, `get_subscription_count` | none | Discovery |
| `get_merchant_plans`, `get_subscriber_subscriptions` | none | Indexed lookups |
| `bump_plan`, `bump_subscription` | none | Permissionless TTL maintenance |

Full signatures, error codes, outcomes, and events are documented in
[`docs/contract-api.md`](docs/contract-api.md). SDK discovery helpers scan at
most 500 IDs per call, and the indexer `/events` endpoint returns at most 500
events per request; larger limits are clamped rather than rejected.

## Security model

- **Escrow, not allowance.** Funds live in the contract. The merchant can only
  receive money through `charge`, one cycle at a time, on schedule.
- **Snapshotted terms.** Existing subscriptions are immune to plan price and
  interval changes.
- **Explicit auth.** Every state-changing entry point except `charge` calls
  `require_auth` for the party it acts for. `charge` is deliberately open and
  can only move funds along the pre-agreed schedule.
- **Refund path is unconditional for subscribers.** A subscriber can always
  cancel and recover the unused balance; subscriptions snapshot the token so a
  refund does not depend on the plan record.
- **Bounded storage growth.** Per-address indexes keep only the most recent 100
  IDs, and persistent records support permissionless TTL bumps.
- **SAC-only assumption.** The plan token must be a standard Stellar Asset
  Contract. Do not point a plan at an arbitrary malicious contract.

The contract has not been audited. Treat the current deployment as a testnet
prototype until an audit is complete. See [`docs/architecture.md`](docs/architecture.md)
for the full threat model and limitations.

## SCF alignment

SubStream is built for the SCF 7.0 **Open Track**:

- It is a novel, Soroban-native protocol, not a thin wrapper around an existing
  building block.
- It is a public good: any wallet, merchant, or payment processor can use the
  contract, SDK, and keeper without permission.
- Its milestones are verifiable on chain: deployed contract, published SDK,
  working dApp, keeper metrics, and mainnet launch.
- It expands what Stellar can do with its existing assets: subscriptions are
  the missing payments primitive for SaaS, memberships, media, APIs, and
  recurring remittances.

The full application draft, milestones, and budget are in
[`docs/scf-application.md`](docs/scf-application.md).

## Roadmap

| Milestone | Scope |
| --- | --- |
| **MVP** | Contract, unit tests, SDK, dApp, keeper, deployment script (this repo) |
| **Testnet** | Public testnet deployment, end-to-end demo, indexer, keeper monitoring, security review, wallet onboarding |
| **Mainnet** | Audit fixes, mainnet deployment, production keeper, documentation, go-live metrics, integrations |

## Contributing

Issues and pull requests are welcome. Run `cargo test` and `npm run typecheck`
before opening a PR. Keep contract changes small and covered by tests.

## License

MIT. See [`LICENSE`](LICENSE).
