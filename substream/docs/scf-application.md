# SCF 7.0 application draft — SubStream

> **Status:** draft for community review. Numbers and team details must be
> finalized before submission. This document is intentionally concrete so
> reviewers can verify the milestones.

## Snapshot

| Field | Value |
| --- | --- |
| Project | SubStream |
| One-liner | Recurring payments and subscriptions for Stellar, settled by Soroban escrow |
| Track | **Open Track** |
| Requested amount | **$60,000 in XLM** |
| Milestones | MVP ($12K), Testnet ($18K), Mainnet ($24K), plus T0 ($6K) |
| Repository | `substream/` in this repository (public, MIT) |
| Stage | Working prototype: contract, 20 Rust + 42 TypeScript tests, SDK, dApp, keeper, indexer, public metrics |
| Team | _[name(s), roles, GitHub, relevant background]_ |
| Contact | _[email / Telegram / Discord]_ |

## Why the Open Track

SubStream is a new protocol, not an integration of an existing SCF building
block. It does not wrap an anchor, oracle, wallet, or DEX. Its value comes from
a Soroban-native escrow and scheduling design that any Stellar asset can use.
It therefore belongs in the Open Track.

## Problem

Stellar has no native recurring-payment primitive. Businesses that need
subscriptions — SaaS, memberships, media, APIs, gyms, recurring remittances —
must choose between:

1. **Custodial processors** that hold user funds and introduce counterparty
   risk.
2. **Per-cycle token approvals** that expire, require repeated wallet
   signatures, and have inconsistent wallet support.
3. **Manual invoicing** that leaks revenue and adds operational overhead.

The missing primitive is a non-custodial, permissionless schedule that works
with the assets Stellar already has.

## Solution

SubStream lets a subscriber prepay N cycles into a Soroban contract. The
contract snapshots the plan terms and releases one cycle at a time to the
merchant when a cycle is due. `charge` is permissionless, so keepers,
merchants, or subscribers can settle payments.

Key properties:

- **One signature to subscribe**, not one per cycle.
- **No allowance expiry.** Funds are escrowed, not delegated.
- **Refund by default.** Cancelling returns the unused balance immediately.
- **Terms cannot be changed under a subscriber.** Plan updates only affect new
  subscriptions.
- **Works with every SAC asset**, including stablecoins and tokenized RWAs.
- **Composable.** Events and read methods let wallets, indexers, and other
  protocols build on top.

## Current status (proof of intent)

This repository already contains the prototype:

- Soroban contract with plan creation, subscription escrow, top-ups,
  permissionless charges, grace periods, refunds, TTL management, and events.
- **20/20 contract tests passing** (`cargo test --workspace`), including grace-period
  expiry, refund-safe token snapshots, bounded discovery indexes, ID overflow,
  plan-update isolation, merchant cancellation, and seeded state-machine
  invariants.
- TypeScript SDK with typed reads/writes, signer adapters, bounded
  due-subscription discovery, and transaction verification.
- React dApp with subscriber, merchant, activity history, and manual keeper
  views.
- Background keeper with dry-run support, loopback metrics, bounded retry
  backoff, and Docker build instructions.
- Bounded event indexer with an HTTP API, OpenAPI schema, and cumulative public
  metrics.
- One-command testnet deployment script.
- Live testnet deployment with a full create → subscribe → charge → cancel
  lifecycle exercised on chain (transaction links in the README).

The existing prototype is **self-funded prior work** and is not part of the
requested budget. Grant funds will pay for hardening, testnet operations,
integration work, and the mainnet launch.

## Architecture

```
Subscriber ──subscribe/top_up──▶ SubStream contract ──charge──▶ Merchant
                                      ▲
                                      │ permissionless
                              Keeper / merchant / subscriber
```

- **Plans** hold merchant, token, amount, interval, grace period, and active
  flag.
- **Subscriptions** snapshot those terms and hold the escrow balance.
- **`charge`** transfers one cycle if due and funded; marks `PastDue` if not;
  cancels and refunds after the grace period.
- **Cancellation** is always refunded to the subscriber, including
  merchant-initiated cancellation.

Full details: [`architecture.md`](architecture.md) and
[`contract-api.md`](contract-api.md).

## Ecosystem impact

- **For merchants:** a Stripe-like recurring model without custody or a
  processor.
- **For wallets:** a subscription primitive to offer natively; any wallet can
  integrate the SDK in a few hundred lines.
- **For other protocols:** subscription cash flows become an on-chain primitive
  that can be composed with lending, treasuries, DAOs, and RWA platforms.
- **For Stellar:** a new payment use case built on existing assets and
  infrastructure, with no custom token required.

## Differentiation

| Approach | Custody | Per-cycle signature | Refund guarantee | Works with SAC |
| --- | --- | --- | --- | --- |
| Custodial billing | Yes | No | Processor-dependent | Yes |
| Token allowance | No | Often | Revocation only | Partial |
| Invoices | No | Yes | No | Yes |
| **SubStream escrow** | **No** | **No** | **Yes, on chain** | **Yes** |

## Milestones

Milestone names are SCF's symbolic MVP / Testnet / Mainnet labels. Each milestone
is 2–4 verifiable deliverables, scoped to roughly 4–6 weeks.

### MVP — hardened reference implementation ($12K, T1 20%)

**Objective:** turn the prototype into a reproducible, well-tested public
reference implementation.

| # | Deliverable | Verification | Budget |
| --- | --- | --- | --- |
| 1 | Invariant and property-based test suite for the charge state machine (balances never negative, refunds ≤ deposits, no charges after cancellation, schedule monotonicity) | Green CI run, published test report, reproducible `cargo test` | $4,000 |
| 2 | Reproducible WASM build, CI (fmt, clippy, tests, TypeScript typecheck), checksummed release bundle with optional GPG signature | GitHub Actions green, release page with WASM hash, `SHA256SUMS`, and build instructions | $2,500 |
| 3 | SDK v0.1: unit tests, typed contract bindings, compiled npm-ready tarball, tagged release, integration test against testnet | Tagged release, `npm pack` tarball, test logs, example app | $3,500 |
| 4 | Keeper v0.1: metrics endpoint, Docker image, dry-run mode, retry/backoff, runbook | Image build instructions, README, sample metrics output | $2,000 |

**Exit criteria:** a third party can clone the repo, run the tests, deploy to
testnet, and operate a keeper using only the documentation.

### Testnet — public beta and integrations ($18K, T2 30%)

**Objective:** run SubStream as a public testnet product with real merchants and
an indexer.

| # | Deliverable | Verification | Budget |
| --- | --- | --- | --- |
| 1 | Public testnet deployment of the contract, dApp, and keeper with seeded demo plans | Live URLs, contract ID on stellar.expert, demo video | $4,000 |
| 2 | Event indexer and read API for plan/subscription discovery and merchant dashboards | Public API endpoint, OpenAPI schema, repository | $5,000 |
| 3 | Security review: threat model, internal review, audit readiness package, and Audit Bank application | Published threat model, fixes merged, audit application submitted | $4,000 |
| 4 | Integration guide and at least two pilot merchants running live testnet subscriptions | Signed pilot agreements, on-chain subscriptions, integration docs | $5,000 |

**Exit criteria:** external users complete the subscribe → charge → cancel
flow without team assistance; the indexer serves production-shaped queries; no
open critical findings from the security review.

### Mainnet — launch and go-live metrics ($24K, T3 40%)

**Objective:** deploy to mainnet with monitoring, documentation, and measurable
usage.

| # | Deliverable | Verification | Budget |
| --- | --- | --- | --- |
| 1 | Mainnet contract deployment, production keeper, alerts, and incident runbook | Mainnet contract ID, public status page, alert configuration | $8,000 |
| 2 | Mainnet launch: merchant onboarding, first 25 subscriptions / 100 settled charges | Public dashboard with on-chain metrics and explorer links | $6,000 |
| 3 | SDK v1.0 and dApp v1.0 with wallet integration, accessibility pass, and user onboarding | Tagged release, npm package, UX audit notes | $6,000 |
| 4 | Documentation site, integration examples, and a public post-mortem / launch report | Live docs, example repos, published report | $4,000 |

**Exit criteria:** mainnet contract live, at least one external merchant with
paying subscribers, and public metrics demonstrating settled charges.

### Tranche mapping

| Tranche | Amount | Trigger |
| --- | --- | --- |
| T0 | $6,000 | Award approval (automatic) |
| T1 | $12,000 | MVP deliverables complete |
| T2 | $18,000 | Testnet deliverables complete |
| T3 | $24,000 | Mainnet deliverables complete |
| **Total** | **$60,000** | |

Audit costs are **not included** in this budget. We will apply to the Soroban
Security Audit Bank for mainnet audit coverage.

## Budget breakdown (bottom-up)

| Area | Amount | What it pays for |
| --- | --- | --- |
| Protocol engineering | $22,000 | Contract hardening, invariant/fuzz tests, review fixes, TTL tooling |
| SDK and indexer | $14,000 | TypeScript SDK, event indexer, read API, integration tests |
| dApp and onboarding | $12,000 | Subscriber/merchant UX, wallet integration, accessibility, pilot onboarding |
| Keeper reliability | $6,000 | Metrics, Docker packaging, retries, alerting, runbooks |
| Operations and docs | $6,000 | Testnet/mainnet deployments, monitoring, documentation, launch report |
| **Total** | **$60,000** | |

## Team

_[Fill in before submission]_

- **[Name]** — protocol and Rust/Soroban engineering. GitHub: _[handle]_.
  Background: _[relevant experience]_.
- **[Name]** — TypeScript SDK, frontend, and developer experience.
  GitHub: _[handle]_. Background: _[relevant experience]_.
- **[Name]** — operations, merchant onboarding, and documentation.
  GitHub: _[handle]_. Background: _[relevant experience]_.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Smart contract bug or loss of funds | Small immutable surface, invariant tests, internal review, Audit Bank audit before mainnet, conservative caps during beta |
| Keeper liveness | Charging is permissionless; subscribers and merchants can settle directly; keeper metrics endpoint supports external alerting |
| Merchant pauses a plan to avoid service | Subscribers can always cancel and recover the full remaining balance; pause is visible on chain |
| Token with non-standard behavior | Document SAC-only support; restrict pilot plans to vetted assets (XLM/USDC) |
| Low merchant adoption | Start with two design partners from the Stellar ecosystem; measure activation and settled charges, not signups |
| Regulatory ambiguity of recurring payments | Non-custodial escrow with explicit user authorization; publish terms; seek legal review before mainnet |

## Post-award sustainability

The contract is MIT-licensed and has no admin key or protocol fee at launch.
Revenue options after traction include an optional integrator fee on plans
(opt-in by merchants), hosted keeper/indexer services, and support contracts.
The core protocol remains free and open source.

## Links

- Repository: [`kazeemmuyideen/Stellar_SubStream_keeper`](https://github.com/kazeemmuyideen/Stellar_SubStream_keeper)
- Demo: _[testnet dApp URL — see `hosting.md`]_
- Demo video: _[URL]_
- Contract (testnet):
  `CBQROANJSSROOEZUZGNRDRUWOWQFZAREE4QLERSTMKVJD2B2T2U6FYMN`
  ([stellar.expert](https://stellar.expert/explorer/testnet/contract/CBQROANJSSROOEZUZGNRDRUWOWQFZAREE4QLERSTMKVJD2B2T2U6FYMN))
- Architecture: [`architecture.md`](architecture.md)
- Contract API: [`contract-api.md`](contract-api.md)
- Threat model: [`threat-model.md`](threat-model.md)
- Indexer API: [`indexer-openapi.json`](indexer-openapi.json)
- Hosting guide: [`hosting.md`](hosting.md)
- Release process: [`release-process.md`](release-process.md)
- Demo script: [`demo-video-script.md`](demo-video-script.md)
- Submission checklist: [`submission-checklist.md`](submission-checklist.md)
