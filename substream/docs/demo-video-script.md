# Demo video script (3–4 minutes)

Goal: show that SubStream is a real, working Soroban primitive, not a mockup.

## 0:00–0:25 — Problem

> "Stellar has no native subscriptions. Merchants either take custody, ask for a
> wallet signature every cycle, or chase invoices. SubStream replaces all three
> with a small escrow contract."

Show the repository README and the contract on stellar.expert.

## 0:25–0:50 — Contract

- Open `contracts/substream/src/lib.rs`.
- Point out `subscribe`, `charge`, `cancel`, and the snapshotted plan terms.
- Mention 9 tests and the CI workflow.

## 0:50–1:50 — Subscriber flow

1. Open the dApp, connect Freighter on **Testnet**.
2. Show the funded testnet balance.
3. Open **Market**, pick the demo plan (1 XLM / 30 days).
4. Subscribe with 2 cycles prepaid; approve in Freighter.
5. Show the subscription card with escrow balance and next charge time.

## 1:50–2:40 — Permissionless charge

1. Open the **Keeper** tab.
2. Explain that anyone can charge; there is no admin key.
3. For a fast demo, create a plan with a short interval first, or run
   `./scripts/demo.sh --interval 10 --cycles 2` in a terminal and show the
   `charged` event and the transaction on stellar.expert.
4. Show the subscription's `next_charge` advancing.

## 2:40–3:15 — Refund guarantee

1. Cancel the subscription from the dApp.
2. Show the unused escrow returned to the subscriber.
3. State that the merchant can never take the remaining balance.

## 3:15–3:40 — Close

> "The contract, SDK, dApp, keeper, and deployment tooling are MIT licensed and
> open source. The next milestone is an indexer, two pilot merchants, and an
> audit before mainnet."

Show the GitHub URL and the live demo URL.

## Recording notes

- Use a clean browser profile with only Freighter installed.
- Fund the demo account with friendbot before recording.
- Keep the terminal font large enough to read transaction hashes.
- Do not show secret keys, `.env` files, or the Freighter recovery phrase.
