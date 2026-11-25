# SubStream architecture

## 1. Design goal

Give Stellar a reusable, non-custodial subscription primitive that works with
any SAC token, requires one signature from the subscriber, and can be settled
by anyone.

The two common designs are:

1. **Allowance / approval model.** The subscriber approves the merchant to pull
   tokens. On Stellar, SAC allowances have expiration ledgers and still require
   the merchant to submit a transfer per cycle. Wallet support is uneven and
   users must re-approve regularly.
2. **Prepaid escrow.** The subscriber moves N cycles into a contract. The
   contract releases one cycle at a time to the merchant.

SubStream uses escrow. It is simpler to reason about, has no allowance expiry,
and gives the subscriber a hard, on-chain refund guarantee. The trade-off is
that funds are locked while the subscription is active — mitigated by instant
cancellation and refund.

## 2. Components

```
┌──────────────┐        ┌──────────────────┐        ┌──────────────┐
│  Subscriber  │        │                  │        │   Merchant   │
│  (Freighter) │───────▶│  SubStream       │───────▶│   account    │
└──────────────┘        │  contract        │ charge └──────────────┘
        │               │                  │
        │               └────────▲─────────┘
        │                        │
        │               ┌────────┴─────────┐
        └── top_up ────▶│ Keeper / anyone  │
                        └──────────────────┘
```

- **Contract** — source of truth for plans, subscriptions, balances, and
  schedules.
- **SDK** — builds, simulates, signs, submits, and polls Soroban transactions.
  Normalizes contract structs into camelCase TypeScript objects.
- **dApp** — subscriber market, personal subscriptions, merchant console, and a
  manual keeper queue.
- **Keeper** — polls the contract for due subscriptions and calls `charge`.

## 3. Data model

### Plan

| Field | Type | Notes |
| --- | --- | --- |
| `merchant` | `Address` | Receives charges; authorized to update the plan |
| `token` | `Address` | SAC contract address |
| `amount` | `i128` | Base units per cycle |
| `interval` | `u64` | Seconds between charges |
| `grace_period` | `u64` | Seconds after a missed charge before cancellation |
| `active` | `bool` | Paused plans cannot be charged or subscribed to |
| `created_at` | `u64` | Ledger timestamp |

### Subscription

| Field | Type | Notes |
| --- | --- | --- |
| `plan_id` | `u64` | Reference to the plan |
| `subscriber` | `Address` | Owner of the escrow and refund recipient |
| `amount` | `i128` | Snapshotted plan amount |
| `interval` | `u64` | Snapshotted interval |
| `grace_period` | `u64` | Snapshotted grace period |
| `balance` | `i128` | Remaining prepaid escrow |
| `next_charge` | `u64` | Earliest timestamp the next cycle can settle |
| `status` | `u32` | `0 = Active`, `1 = PastDue`, `2 = Cancelled` |
| `cycles_paid` | `u32` | Number of successful charges |
| `started_at` | `u64` | Subscription creation timestamp |
| `last_charged_at` | `u64` | Last successful charge timestamp |

Terms are snapshotted deliberately. `update_plan` only changes the plan record;
it does not mutate live subscriptions. This protects subscribers from silent
price increases and makes the contract's behavior easy to audit.

### Storage keys

| Key | Storage | Value |
| --- | --- | --- |
| `PlanCount` | instance | `u64` |
| `SubscriptionCount` | instance | `u64` |
| `Plan(id)` | persistent | `Plan` |
| `Subscription(id)` | persistent | `Subscription` |
| `MerchantPlans(address)` | persistent | `Vec<u64>` |
| `SubscriberSubscriptions(address)` | persistent | `Vec<u64>` |

Persistent entries are bumped to a 90-day TTL when written, with a 30-day
threshold. Instance entries are bumped on every new ID. The permissionless
`bump_plan` and `bump_subscription` helpers let a keeper or indexer keep
long-idle records alive. Refunds do not depend on this maintenance because
subscriptions snapshot the token address.

## 4. Lifecycle

```
                 subscribe
                     │
                     ▼
                 ┌────────┐   charge (balance >= amount)   ┌────────┐
                 │ Active │◀───────────────────────────────│ Active │
                 └───┬────┘                                 └────────┘
                     │ charge (balance < amount)
                     ▼
                 ┌─────────┐  top_up in grace / charge succeeds
                 │ PastDue │─────────────────────────────▶ Active
                 └────┬────┘
                      │ now > next_charge + grace_period
                      ▼
                 ┌───────────┐
                 │ Cancelled │  (remaining balance refunded)
                 └───────────┘
                      ▲
        cancel / cancel_by_merchant
```

A cancellation is terminal. A cancelled subscription cannot be topped up or
charged again; the subscriber must create a new subscription. The grace deadline
is enforced by both `charge` and `top_up` for any subscription whose escrow is
short, even if it still shows `Active` because nobody called `charge`. A late
top-up refunds any remaining escrow, cancels the subscription, and emits
`cancelled` with reason `1`.

## 5. Charge algorithm

`charge(subscription_id)` is the protocol's core:

1. Load the subscription. If it is cancelled, return `Cancelled`.
2. If `now < next_charge`, return `NotDue` without loading the plan.
3. Finalize an expired, underfunded subscription before touching the plan:
   transfer any remaining balance to the subscriber, mark it cancelled, emit
   `cancelled` (reason `1`), and return `Cancelled`. This also applies when the
   plan is paused or its record is archived.
4. Load the plan. If it is paused, return `PlanInactive` without changing the
   subscription. The schedule does not advance while paused.
5. If `balance < amount`, mark the subscription `PastDue`, emit `pay_fail`, and
   return `InsufficientBalance`. `next_charge` does not advance, so a top-up is
   immediately usable.
6. Otherwise transfer `amount` from the contract to the merchant, decrement the
   balance, increment `cycles_paid`, set `next_charge = now + interval`, mark
   `Active`, and emit `charged`. The counter and schedule use checked arithmetic
   and return `Overflow` instead of wrapping at their maximum values.

Important properties:

- Charging is idempotent with respect to time: repeated calls before
  `next_charge` return `NotDue` and move no funds.
- Expiry is enforced on both paths. A `top_up` that would restore enough escrow
  sets the status back to `Active` while the grace window is open, but the same
  call cancels and refunds once the deadline has passed.
- A keeper cannot steal funds. It can only trigger the exact transfer the
  subscriber already authorized by subscribing.
- A merchant cannot charge a cancelled subscription or skip the schedule.
- `next_charge` is based on the ledger timestamp at settlement, not on the
  original schedule. This avoids unbounded catch-up bursts if a subscription
  goes uncharged for several intervals; the subscriber pays for one cycle and
  the next cycle starts from settlement time.

## 6. Authorization matrix

| Entry point | Required auth | Who can call |
| --- | --- | --- |
| `create_plan` | `merchant` | Anyone creating their own plan |
| `update_plan` | `merchant` | The plan's merchant |
| `subscribe` | `subscriber` | Anyone subscribing themselves |
| `top_up` | `subscriber` | The subscription's subscriber |
| `charge` | none | Anyone |
| `cancel` | `subscriber` | The subscription's subscriber |
| `cancel_by_merchant` | `merchant` | The plan's merchant, only if the plan is paused or the subscription is past due |
| Reads | none | Anyone |

Merchant cancellation exists for abuse and cleanup cases, but it can never
redirect escrow: the refund always goes to the subscriber.

## 7. Security considerations

### Custody

The contract holds user funds. The attack surface is intentionally small: one
token transfer per charge, no upgrades, no admin keys, no arbitrary calls.

### Reentrancy

Soroban's SAC tokens do not call back into the caller, and the contract does not
invoke user-controlled code. Tokens with custom behavior should be treated as
untrusted; the contract assumes standard SAC semantics. The test suite uses the
built-in Stellar Asset Contract.

### Rounding and decimals

Amounts are `i128` base units. The contract does no decimal conversion; the SDK
and dApp handle display formatting. Merchants must create plans with amounts in
the token's base units.

### Overflow

All arithmetic uses `checked_*` where user input can grow balances or deposits,
and returns `Overflow`. `cycles_paid` uses saturating addition. Timestamp
additions fall back to `u64::MAX` if they would overflow, which effectively
disables further charges rather than wrapping.

### Griefing

- Anyone can call `charge`, including a malicious actor. That is acceptable:
  the only effect is settling a payment the subscriber already funded.
- A merchant can pause a plan, blocking new charges. Existing subscribers can
  cancel and recover their full remaining balance. Pausing is therefore not a
  theft vector, but it is a liveness vector that subscribers should understand.
- A keeper can choose not to submit charges. The subscriber and merchant can
  always charge themselves, so keeper liveness is not a single point of failure.

### TTL / archival

Soroban persistent entries can be archived if untouched. This implementation
extends TTL on every write and exposes permissionless `bump_plan` and
`bump_subscription` helpers. A production deployment should call them
periodically for records that are far from their next charge. Subscriptions
snapshot the token address, so a refund remains possible even if the plan
record is archived.

### Trust assumptions

- The plan token is a legitimate SAC.
- Ledger timestamps are the scheduling source of truth (they are close to wall
  clock time but can drift slightly).
- The merchant will honor the service off-chain; the contract only handles
  payment.

## 8. Why not X?

**Why not SEP-41 allowances?** Allowances expire and still require a
transaction per cycle, plus wallet UX for re-approval. Escrow gives a stronger
refund guarantee and a simpler keeper story.

**Why not one contract per subscription?** Deployment cost and discovery
complexity. A single contract with indexed storage is cheaper and easier to
compose with.

**Why not put the schedule in the token?** Stellar assets are intentionally
simple. Subscription logic belongs in a contract.

**Why no upgradeability?** Immutability is a feature for a custody contract.
New behavior ships as a new contract and merchants/subscribers opt in.

## 9. Scaling and indexing

The contract exposes `get_plan_count` / `get_subscription_count` and per-address
indexes. The SDK scans IDs up to a caller-supplied limit; it has no cursor API.
The contract deliberately does not maintain a global enumerable list, which
would make writes unbounded.

The bundled `services/indexer` supplies the off-chain read model. It polls
Soroban RPC `getEvents` with a contract filter for the seven event topics
(`plan_new`, `plan_upd`, `subscribe`, `topped_up`, `charged`, `pay_fail`,
`cancelled`), decodes them, deduplicates by RPC event id plus a persisted
high-water ledger/event id, and persists a newest-first cache to a JSON file.
An HTTP API exposes `/events` (with `subscriber`, `subscriptionId`, and `limit`
filters), `/health`, `/stats`, and `/metrics`. Metrics are incremental, persisted
counters grouped by merchant and plan: successful and failed charges, new
subscriptions, top-ups, cancellations, and settled/refunded base-unit totals by
token. `/metrics` can be called without a wallet for public network totals or
with `merchant=G...` for a scoped view. The dApp validates those payloads, caps
the displayed token and plan arrays, refreshes them every minute, and falls back
to current contract state when the indexer is unavailable, so the indexer is
never a liveness dependency.

The indexer is read-only and holds no keys. Its state is a cache, not a source
of truth: events are bounded by RPC retention, and a fresh deployment should
set `START_LEDGER` to the contract's creation ledger to capture full history.
Metrics are cumulative from the first event the indexer observed, not an audited
ledger; deductions that are attributed from later events (for example, a token
first seen in `plan_new`) are reported as `unknown` when they cannot be
resolved.

## 10. Future work

- Proration and mid-cycle plan changes.
- Trials, coupons, and one-off discounts.
- Multi-token plans and cross-asset settlement via Stellar DEX paths.
- Subscription NFTs or transferable positions.
- An on-chain keeper reward or a decentralised keeper network.
- A formal audit and an invariant/fuzz test suite (e.g. `cargo-fuzz`,
  property-based tests over the charge state machine).
