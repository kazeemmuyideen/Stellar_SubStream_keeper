# @substream/sdk

Typed TypeScript client for the [SubStream](../../README.md) Soroban escrow
contract. It handles Soroban RPC calls, XDR encoding, read helpers, and tagging
of submitted transactions.

## Install

```bash
npm install @substream/sdk @stellar/stellar-sdk
```

## Example

```ts
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { keypairSigner, SubStreamClient } from "@substream/sdk";

const client = new SubStreamClient({
  contractId: "C...",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: Networks.TESTNET,
});
const signer = keypairSigner(Keypair.fromSecret(process.env.SECRET!));

const { hash } = await client.createPlan({
  source: Keypair.fromSecret(process.env.SECRET!).publicKey(),
  signer,
  token: "C...SAC token address",
  amount: 10_000_000n,
  interval: 2_592_000n,
  gracePeriod: 86_400n,
});
```

See [`src/client.ts`](src/client.ts) for the full method list and parameter
types. All token amounts are `bigint` values in the token's base units.

## Development and release

From `substream/`:

```bash
npm run build -w @substream/sdk   # emits dist/index.js + declarations
npm run test -w @substream/sdk
npm pack -w @substream/sdk --dry-run
```

`prepack` rebuilds `dist/` so a published tarball always contains compiled
JavaScript and type declarations.
