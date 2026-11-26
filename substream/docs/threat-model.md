# SubStream threat model

This is an internal review aid, not a third-party audit. It records the trust
boundaries and mitigations implemented in the repository today.

## Assets and actors

| Asset | Trust property | Actor |
| --- | --- | --- |
| Escrowed tokens in the contract | Never transferable except a due charge or a refund | Subscriber, merchant, keeper, anyone |
| Subscription schedule | Only advances on a successful charge | Anyone |
| Plan terms | Cannot change for an existing subscription | Merchant |
| Keeper signing key | Pays fees only; never custodies escrow | Keeper operator |
| Indexer state | Read model; never authoritative for balances | Indexer operator |

## Threats and mitigations

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Merchant changes plan amount after a subscriber joins | Amount, interval, grace period, and token are snapshotted into the subscription at `subscribe` | Subscriber must still review terms before signing |
| Merchant pauses plan to force funds back | Subscriber can cancel at any time and receive the full balance; grace expiry refunds even if the plan is paused | Paused plans block new charges until reactivated |
| Keeper misses charges | `charge` is permissionless; subscriber/merchant can call it; keeper uses bounded backoff after failures | Liveness depends on someone noticing due cycles |
| Keeper key is compromised | Use a dedicated, minimally funded account; no admin role; no protocol fee; secret is env-only and excluded from git | Attacker can waste keeper fee balance, not escrow |
| Replay / double charging | Schedule advances only after a successful transfer; repeated charges before the next due date return `NOT_DUE` | Clock assumptions follow Soroban ledger timestamps |
| Integer overflow in cycles or schedule | Checked arithmetic returns `Overflow`; cycle counters never wrap | None known in contract scope |
| TTL expiry of records | Permissionless `bump_plan` / `bump_subscription` helpers; operators should monitor and extend | Long-idle records still require maintenance |
| Non-standard token behavior | SAC-only support; pilots restricted to vetted assets | Malicious custom tokens remain out of scope |
| RPC cursor retention gaps in indexer | Cursor is persisted; out-of-range errors re-anchor without replaying retained events; `/events` is explicitly a bounded window | Lifetime metric gaps are possible if state file is lost |
| Malicious indexer response in the dApp | Payloads are validated and capped before rendering | Users must trust the configured indexer URL |
| Metrics endpoint leaks secrets | Keeper endpoint binds loopback and returns counters only; indexer endpoint is read-only JSON | Public metrics are indexer-derived, not on-chain accounting |
| Unlimited response or index growth | Event, plan, merchant, subscription, and token bounds are enforced in contract and indexer | Extremely large deployments hit documented caps |

## Out of scope for the first release

- Auditing third-party SAC token implementations.
- Legal characterization of recurring payments in each jurisdiction.
- Protecting users who sign a subscription they have not read.
- Guaranteeing keeper uptime without an external monitoring contract.
