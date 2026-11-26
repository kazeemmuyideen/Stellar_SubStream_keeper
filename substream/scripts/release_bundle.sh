#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

out="$root/dist/release"
rm -rf "$out"
mkdir -p "$out"

stellar contract build --manifest-path contracts/substream/Cargo.toml
cp target/wasm32v1-none/release/substream_contract.wasm "$out/substream.wasm"

npm run build -w @substream/sdk >/dev/null
npm pack -w @substream/sdk --pack-destination "$out" >/dev/null

(
  cd "$out"
  sha256sum substream.wasm ./*.tgz > SHA256SUMS
  if [[ -n "${RELEASE_SIGNING_KEY:-}" ]]; then
    command -v gpg >/dev/null
    gpg --batch --yes --armor --detach-sign \
      --local-user "$RELEASE_SIGNING_KEY" \
      --output SHA256SUMS.asc SHA256SUMS
  fi
)

echo "Release bundle: $out"
sha256sum "$out"/* | sed "s#$out/##"
