# SubStream keeper

The keeper is an optional bot that polls for due subscriptions and submits
`charge` transactions. Charging is permissionless, so running it is never
required to use SubStream.

## What it needs

| Variable | Meaning |
| --- | --- |
| `CONTRACT_ID` | Deployed SubStream contract (`C...`) |
| `KEEPER_SECRET` | Secret key (`S...`) of a funded Stellar account that pays fees |
| `RPC_URL` | Soroban RPC endpoint; defaults to testnet |
| `NETWORK_PASSPHRASE` | Network passphrase; defaults to testnet |
| `POLL_INTERVAL_MS` | Delay between checks (default `30000`) |
| `MAX_SUBSCRIPTIONS` | Maximum subscriptions scanned per pass |
| `DRY_RUN` | `1` logs charges without submitting them |

## Configure it automatically

From the repository root:

```bash
./scripts/configure-keeper.sh
```

This reads the contract ID from `apps/web/.env`, copies the secret key of the
local `substream-deployer` identity into `.env`, and restricts the file to your
user. It never prints the secret.

## Run it

```bash
npm run keeper:once      # one pass, then exit
npm run keeper:dry-run   # one pass, log only
npm run keeper           # continuous loop; Ctrl+C to stop
```

`no subscriptions due` means the read path is healthy and nothing needs
charging yet.

The keeper account only needs XLM for network fees. Subscriber funds stay in
contract escrow and are never held by the keeper. On testnet, top up the keeper
account with:

```bash
curl "https://friendbot.stellar.org?addr=G...keeper-public-key..."
```
