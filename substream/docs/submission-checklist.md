# SCF submission checklist

Use this before submitting the Open Track application. Everything that can be
verified without private accounts is already done.

## Ready in the repository

- [x] Soroban contract with plans, escrow subscriptions, permissionless
      charges, grace periods, refunds, and typed events.
- [x] 9 contract tests passing; `cargo fmt --check` and
      `cargo clippy --all-targets -- -D warnings` clean.
- [x] Reproducible WASM build documented; current hash
      `c6a7ccd0b98304b2eb4d2ef7739d0fb0b4f28478f74b9cd1e5302d54ac5bb786`.
- [x] TypeScript SDK, React dApp, and keeper service; typecheck and production
      build pass.
- [x] CI workflow covering contract fmt/clippy/tests/WASM plus TypeScript
      typecheck/build.
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
- [ ] Demo video URL. Suggested flow is in
      [`demo-video-script.md`](demo-video-script.md).
- [ ] Confirm the $60,000 Open Track budget and tranche split, or adjust the
      milestone tables.
- [ ] Re-read the final text for team-specific claims; remove anything the team
      cannot commit to.

## Final verification commands

```bash
cd substream
cargo test
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
stellar contract build
npm ci
npm run typecheck
npm run build
./scripts/demo.sh --interval 10 --cycles 2
```

Record the output of the last command (transaction links) as additional
evidence in the application.
