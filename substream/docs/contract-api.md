# Contract API

Contract crate: `contracts/substream` (`substream-contract`)

All amounts are `i128` in the token's base units. All times are Unix seconds
from the ledger timestamp.

## Types

### `Plan`

```rust
pub struct Plan {
    pub merchant: Address,
    pub token: Address,
    pub amount: i128,
    pub interval: u64,
    pub grace_period: u64,
    pub active: bool,
    pub created_at: u64,
}
```

### `Subscription`

```rust
pub struct Subscription {
    pub plan_id: u64,
    pub subscriber: Address,
    pub amount: i128,
    pub interval: u64,
    pub grace_period: u64,
    pub balance: i128,
    pub next_charge: u64,
    pub status: u32,
    pub cycles_paid: u32,
    pub started_at: u64,
    pub last_charged_at: u64,
}
```

### Status codes

| Value | Name | Meaning |
| --- | --- | --- |
| `0` | `Active` | Schedule is live and escrow covers the next cycle; a sufficient top-up restores this status |
| `1` | `PastDue` | A charge was attempted with insufficient escrow; grace period is running |
| `2` | `Cancelled` | Terminal; remaining balance was refunded |

### Charge outcome codes

`charge` returns `Result<u32, Error>` so a settlement attempt does not abort the
transaction for expected business outcomes.

| Value | Name | Meaning |
| --- | --- | --- |
| `0` | `Charged` | One cycle was transferred to the merchant |
| `1` | `NotDue` | `now < next_charge`; nothing changed |
| `2` | `InsufficientBalance` | Marked `PastDue` (or refunded and cancelled if grace expired) |
| `3` | `Cancelled` | Subscription was already cancelled, or was cancelled by this call |
| `4` | `PlanInactive` | Plan is paused; nothing changed |

### Errors

| Value | Name | When |
| --- | --- | --- |
| `1` | `PlanNotFound` | No plan with that id |
| `2` | `SubscriptionNotFound` | No subscription with that id |
| `3` | `InvalidAmount` | `amount <= 0` |
| `4` | `InvalidInterval` | `interval == 0` |
| `5` | `InvalidCycles` | `cycles == 0` |
| `6` | `PlanInactive` | Subscribing or topping up on a paused plan |
| `7` | `AlreadyCancelled` | Cancelling an already-cancelled subscription |
| `8` | `Unauthorized` | Wrong merchant/subscriber, or merchant cancel not allowed |
| `9` | `Overflow` | Arithmetic overflow |

## Writes

### `create_plan`

```rust
pub fn create_plan(
    env: Env,
    merchant: Address,
    token: Address,
    amount: i128,
    interval: u64,
    grace_period: u64,
) -> Result<u64, Error>
```

Requires `merchant.require_auth()`. Validates `amount > 0` and `interval > 0`.
Returns the new plan id (1-based). Emits `plan_new`.

### `update_plan`

```rust
pub fn update_plan(
    env: Env,
    merchant: Address,
    plan_id: u64,
    amount: i128,
    interval: u64,
    grace_period: u64,
    active: bool,
) -> Result<(), Error>
```

Requires merchant auth and plan ownership. Only affects subscriptions created
after the update. Existing subscriptions keep their snapshot. Setting
`active = false` prevents new subscriptions and charges but lets subscribers
cancel with a refund. Emits `plan_upd`.

### `subscribe`

```rust
pub fn subscribe(
    env: Env,
    subscriber: Address,
    plan_id: u64,
    cycles_prepaid: u32,
) -> Result<u64, Error>
```

Requires subscriber auth. Transfers
`plan.amount * cycles_prepaid` from the subscriber to the contract. Returns the
new subscription id. `next_charge` is set to `now + plan.interval`. Emits
`subscribe`.

### `top_up`

```rust
pub fn top_up(
    env: Env,
    subscriber: Address,
    subscription_id: u64,
    cycles: u32,
) -> Result<i128, Error>
```

Requires subscriber auth and ownership. Transfers `subscription.amount * cycles`
into escrow and returns the new balance. Fails if the subscription is cancelled
or the plan is paused. A top-up that brings escrow up to at least one cycle
sets the status back to `Active` (`PastDue` is kept when the balance is still
short). Emits `topped_up` when a deposit is made.

If the subscription is `PastDue` and `now > next_charge + grace_period`, no
deposit is taken: the subscription is cancelled, any remaining escrow is
refunded, `cancelled` with reason `1` is emitted, and `0` is returned.

### `charge`

```rust
pub fn charge(env: Env, subscription_id: u64) -> Result<u32, Error>
```

No auth. Settles at most one cycle. See the algorithm in
[`architecture.md`](architecture.md#5-charge-algorithm). Emits `charged` or
`pay_fail`, and may emit `cancelled` with reason `1` when the grace period has
expired. `top_up` enforces the same deadline.

### `cancel`

```rust
pub fn cancel(
    env: Env,
    subscriber: Address,
    subscription_id: u64,
) -> Result<i128, Error>
```

Requires subscriber auth and ownership. Transfers the entire remaining balance
back to the subscriber, marks the subscription cancelled, and returns the
refunded amount. Emits `cancelled` with reason `0`.

### `cancel_by_merchant`

```rust
pub fn cancel_by_merchant(
    env: Env,
    merchant: Address,
    subscription_id: u64,
) -> Result<i128, Error>
```

Requires merchant auth and plan ownership. Allowed only when the plan is paused
or the subscription is `PastDue`. Refunds the remaining balance to the
subscriber and returns it. Emits `cancelled` with reason `2`.

## Reads

```rust
pub fn get_plan(env: Env, plan_id: u64) -> Result<Plan, Error>
pub fn get_subscription(env: Env, subscription_id: u64) -> Result<Subscription, Error>
pub fn get_plan_count(env: Env) -> u64
pub fn get_subscription_count(env: Env) -> u64
pub fn get_merchant_plans(env: Env, merchant: Address) -> Vec<u64>
pub fn get_subscriber_subscriptions(env: Env, subscriber: Address) -> Vec<u64>
pub fn is_due(env: Env, subscription_id: u64) -> Result<bool, Error>
pub fn quote(env: Env, plan_id: u64, cycles: u32) -> Result<i128, Error>
```

`is_due` is `status != Cancelled && now >= next_charge`. It does not check plan
activity or balance. `quote` returns `amount * cycles`.

Reads use simulation, so the source account does not need to exist on chain for
the SDK's read path (it falls back to a zero sequence account).

## Events

Events are declared with `#[contractevent]`. Each has a fixed topic symbol plus
the record id, and a data map keyed by field name.

| Event | Topics | Data map keys |
| --- | --- | --- |
| `plan_new` | `("plan_new", plan_id)` | `merchant`, `token`, `amount`, `interval`, `grace_period` |
| `plan_upd` | `("plan_upd", plan_id)` | `amount`, `interval`, `active` |
| `subscribe` | `("subscribe", subscription_id)` | `plan_id`, `subscriber`, `deposit`, `next_charge` |
| `topped_up` | `("topped_up", subscription_id)` | `subscriber`, `amount`, `balance` |
| `charged` | `("charged", subscription_id)` | `plan_id`, `subscriber`, `merchant`, `amount`, `next_charge` |
| `pay_fail` | `("pay_fail", subscription_id)` | `plan_id`, `subscriber`, `balance` |
| `cancelled` | `("cancelled", subscription_id)` | `subscriber`, `refund`, `reason` |

Cancellation reasons: `0 = subscriber`, `1 = grace period expired`,
`2 = merchant`. Reason `1` can be emitted by either `charge` or `top_up`.

## TTL

| Entry | Threshold | Extension |
| --- | --- | --- |
| Persistent plans/subscriptions/indexes | 30 days | 90 days |
| Instance counters | 30 days | 90 days |

Constants assume ~5 second ledgers: `DAY_IN_LEDGERS = 17_280`.

## CLI examples

```bash
# Create a 5 USDC / 30 day plan with a 1 day grace period, using a 7-decimal SAC
stellar contract invoke \
  --id "$CONTRACT_ID" --source alice --network testnet \
  -- create_plan \
  --merchant G... --token C... \
  --amount 50000000 --interval 2592000 --grace_period 86400

# Prepay 3 cycles
stellar contract invoke \
  --id "$CONTRACT_ID" --source alice --network testnet \
  -- subscribe --subscriber G... --plan_id 1 --cycles_prepaid 3

# Charge a due subscription (any funded source account)
stellar contract invoke \
  --id "$CONTRACT_ID" --source keeper --network testnet \
  -- charge --subscription_id 1

# Read state
stellar contract invoke \
  --id "$CONTRACT_ID" --source alice --network testnet \
  -- get_subscription --subscription_id 1
```

## SDK examples

```ts
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { SubStreamClient, keypairSigner } from "@substream/sdk";

const client = new SubStreamClient({
  contractId: process.env.CONTRACT_ID!,
  networkPassphrase: Networks.TESTNET,
});

const keeper = Keypair.fromSecret(process.env.KEEPER_SECRET!);
const signer = keypairSigner(keeper);

const { planId } = await client.createPlan({
  merchant: keeper.publicKey(),
  token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  amount: 50_000_000n, // 5 XLM at 7 decimals
  interval: 2_592_000n, // 30 days
  gracePeriod: 86_400n, // 1 day
  signer,
});

await client.subscribe({
  subscriber: keeper.publicKey(),
  planId,
  cycles: 3,
  signer,
});

const due = await client.getDueSubscriptions(keeper.publicKey());
for (const subscription of due) {
  const { outcome } = await client.charge({
    subscriptionId: subscription.id,
    source: keeper.publicKey(),
    signer,
  });
  console.log(subscription.id, outcome);
}
```

The SDK normalizes snake_case contract fields to camelCase and adds the plan or
subscription `id` to read results, since the id is not stored inside the struct.
