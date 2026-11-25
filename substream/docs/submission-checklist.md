# SCF submission checklist

Use this before submitting the Open Track application. Everything that can be
verified without private accounts is already done.

## Ready in the repository

- [x] Soroban contract with plans, escrow subscriptions, permissionless
      charges, grace periods, refunds, and typed events.
- [x] 19 contract tests passing; `cargo fmt --check` and
      `cargo clippy --all-targets -- -D warnings` clean.
- [x] Reproducible WASM build documented; current source hash
      `159c0f098e8ca4068709b50081731e175f79327166928679c7b9f2969e093af7`.
      The live testnet deployment still runs the previous WASM until it is
      redeployed.
- [x] TypeScript SDK, React dApp, keeper, and indexer; 36 tests passing, plus
      typecheck, audit, and production build.
- [x] Public `/metrics` endpoint and merchant analytics: revenue by token,
      charge success rate, plan breakdowns, failures, and refunds.
- [x] Root CI workflow covering skills/manifests/secrets, contract
      fmt/clippy/tests/WASM, and TypeScript audit/typecheck/tests/build.
- [x] Live testnet deployment with recorded transaction links in
      [`../deployments/testnet.json`](../deployments/testnet.json).
- [x] One-command deploy (`scripts/deploy.sh`) and keeper setup
      (`scripts/configure-keeper.sh`).
- [x] End-to-end lifecycle demo (`scripts/demo.sh`) for reproducing on-chain
      evidence.
- [x] Architecture, contract API, and threat model documentation.
- [x] MIT license.

## Needs a human before submission

- [ ] Team names, roles, GitHub handles, and relevant background
      (`docs/scf-application.md`, **Team** section).
- [ ] Contact email / Telegram / Discord.
- [ ] Public GitHub repository URL (push `substream/` to its own repo or a
      public branch).
- [ ] Public demo URL for the dApp (for example Vercel, Netlify, or Cloudflare
      Pages). Set the `VITE_*` variables from `apps/web/.env.example`.
- [ ] Redeploy the contract with the lifecycle and hardening fixes, then update
      `wasmHash` and the transaction links in `deployments/testnet.json` and
      re-run `scripts/demo.sh` for fresh evidence. Use a fresh contract or plan
      a migration: the hardened `Subscription` struct adds a snapshotted token
      field and is not storage-compatible with the live deployment.
- [ ] Demo video URL. Suggested flow is in
      [`demo-video-script.md`](demo-video-script.md).
- [ ] Confirm the $60,000 Open Track budget and tranche split, or adjust the
      milestone tables.
- [ ] Re-read the final text for team-specific claims; remove anything the team
      cannot commit to.

## Final verification commands

```bash
cd substream
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
stellar contract build
npm ci
npm audit --audit-level=high
npm run typecheck
npm test
npm run build
./scripts/demo.sh --interval 10 --cycles 2
```

Record the output of the last command (transaction links) as additional
evidence in the application.
