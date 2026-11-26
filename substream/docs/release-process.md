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
Publishing to npm requires registry credentials and is intentionally a human
step. Do not reuse an already-deployed contract ID for a new WASM unless the
storage layout is unchanged or a migration is planned.
