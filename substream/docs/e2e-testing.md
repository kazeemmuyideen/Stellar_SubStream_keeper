# Browser E2E tests

The dApp has four Chromium E2E tests in
[`../apps/web/e2e/`](../apps/web/e2e/). They cover:

- the complete guided lifecycle: create plan → subscribe → charge → cancel;
- subscription manager filters, search, and cancellation state;
- public metrics charts and CSV export;
- graceful degradation when the indexer is offline.

Run them from `substream/`:

```bash
npm ci
npx playwright install --with-deps chromium
npm run e2e
```

`npm run e2e` builds the SDK first, then launches Vite on `127.0.0.1:4173` via
[`../apps/web/playwright.config.ts`](../apps/web/playwright.config.ts).

## Determinism and isolation

The tests enable `VITE_E2E_FIXTURES=1`, a **development-only** flag. In that
mode, connecting loads an in-memory `E2EClient` instead of Freighter and Soroban
RPC. This keeps the suite deterministic and free of testnet fees while still
exercising the real React components, state transitions, CSV download, and
indexer HTTP boundary. Playwright routes the mocked indexer host
`https://indexer.e2e.local` for `/events` and `/metrics`; no public endpoint is
contacted by the browser tests.

The fixture client is dynamically imported and gated by `import.meta.env.DEV`
and the opt-in env flag, so the branch is disabled in production builds. Never
set `VITE_E2E_FIXTURES` for a public deployment.

For on-chain evidence, use [`demo.sh`](../scripts/demo.sh) instead; the browser
suite is not a substitute for a live transaction test.
