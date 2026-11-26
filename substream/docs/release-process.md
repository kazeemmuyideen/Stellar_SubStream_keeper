# SubStream release process

Releases are reproducible bundles, not live deployments. Creating a bundle does
not change the contract deployed in [`../deployments/testnet.json`](../deployments/testnet.json).

```bash
cd substream
./scripts/release_bundle.sh
```

The script writes `dist/release/`:

- `substream.wasm` from `stellar contract build`;
- an npm-ready `@substream/sdk` tarball from `npm pack`;
- `SHA256SUMS` covering both files;
- `SHA256SUMS.asc` only when `RELEASE_SIGNING_KEY` names a local GPG key.

To verify a downloaded bundle:

```bash
cd dist/release
sha256sum --check SHA256SUMS
gpg --verify SHA256SUMS.asc SHA256SUMS   # when a signature is provided
```

Publish the bundle on a GitHub release and tag SDK releases as `sdk-v0.1.0`.

## SDK release checks

Before tagging, verify that the package version, tag, exports, and tarball
contents agree:

```bash
cd substream
npm run build -w @substream/sdk
SDK_RELEASE_TAG=sdk-v0.1.0 npm run sdk:check-release
```

The check rejects a mismatched tag, missing `dist/index.js` or declarations,
incorrect exports, or a tarball containing `src/` or `.env` files. Pushing a
`sdk-v*` tag runs the same check in CI and then publishes with npm provenance
via [`.github/workflows/sdk-release.yml`](../../.github/workflows/sdk-release.yml).
Publishing requires the repository's `NPM_TOKEN`; no registry credential is
committed.

## Container images

Pushing a `v*` tag builds and publishes the keeper and indexer images to GHCR
with [`.github/workflows/publish-images.yml`](../../.github/workflows/publish-images.yml).
Manual runs from the Actions tab publish a `manual-<sha>` tag.

Do not reuse an already-deployed contract ID for a new WASM unless the storage
layout is unchanged or a migration is planned.
