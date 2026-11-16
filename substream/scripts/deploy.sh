#!/usr/bin/env bash
#
# Build and deploy the SubStream contract with the Stellar CLI.
#
# Usage:
#   ./scripts/deploy.sh testnet
#   ./scripts/deploy.sh mainnet
#   ./scripts/deploy.sh local
#
# Environment:
#   STELLAR_IDENTITY   key name used by the Stellar CLI (default: substream-deployer)
#   RPC_URL            override the Soroban RPC endpoint
#   NETWORK_PASSPHRASE override the network passphrase
#   SKIP_BUILD=1       reuse an existing wasm build
#
set -euo pipefail

NETWORK="${1:-testnet}"
IDENTITY="${STELLAR_IDENTITY:-substream-deployer}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$NETWORK" in
  testnet)
    DEFAULT_RPC="https://soroban-testnet.stellar.org"
    DEFAULT_PASSPHRASE="Test SDF Network ; September 2015"
    FUND_IDENTITY=1
    ;;
  mainnet | public)
    NETWORK="mainnet"
    DEFAULT_RPC="https://soroban-rpc.mainnet.stellar.gateway.fm"
    DEFAULT_PASSPHRASE="Public Global Stellar Network ; September 2015"
    FUND_IDENTITY=0
    ;;
  local | standalone)
    DEFAULT_RPC="http://localhost:8000/soroban/rpc"
    DEFAULT_PASSPHRASE="Standalone Network ; February 2017"
    FUND_IDENTITY=0
    ;;
  *)
    echo "Usage: $0 [testnet|mainnet|local]" >&2
    exit 1
    ;;
esac

RPC_URL="${RPC_URL:-$DEFAULT_RPC}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-$DEFAULT_PASSPHRASE}"

if ! command -v stellar >/dev/null 2>&1; then
  cat >&2 <<'EOF'
The Stellar CLI is required.

Install it with one of:
  cargo install --locked stellar-cli
  brew install stellar-cli
  https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli

Then re-run this script.
EOF
  exit 1
fi

echo "==> Building contract"
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  (cd "$ROOT" && stellar contract build)
fi

WASM="$(
  find "$ROOT/target" -type f \
    \( -path '*wasm32v1-none/release/substream_contract.wasm' \
       -o -path '*wasm32-unknown-unknown/release/substream_contract.wasm' \) \
    -printf '%T@ %p\n' 2>/dev/null |
    sort -nr |
    head -n1 |
    cut -d' ' -f2-
)"

if [[ -z "${WASM:-}" || ! -f "$WASM" ]]; then
  echo "Could not find substream_contract.wasm under $ROOT/target." >&2
  echo "Run 'stellar contract build' and try again." >&2
  exit 1
fi
echo "==> Using wasm: $WASM"

if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  echo "==> Creating identity '$IDENTITY'"
  if [[ "$FUND_IDENTITY" == "1" ]]; then
    stellar keys generate "$IDENTITY" --fund
  else
    stellar keys generate "$IDENTITY"
  fi
fi

echo "==> Deploying to $NETWORK"
DEPLOY_OUTPUT="$(
  stellar contract deploy \
    --wasm "$WASM" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" 2>&1
)"
echo "$DEPLOY_OUTPUT"

CONTRACT_ID="$(printf '%s\n' "$DEPLOY_OUTPUT" | grep -oE '\bC[A-Z2-7]{55}\b' | head -n1 || true)"
if [[ -z "$CONTRACT_ID" ]]; then
  echo "Could not parse a contract id from the deploy output." >&2
  exit 1
fi

echo
echo "Contract ID: $CONTRACT_ID"

WEB_ENV="$ROOT/apps/web/.env"
if [[ "${SKIP_WRITE_ENV:-0}" != "1" ]]; then
  {
    echo "VITE_CONTRACT_ID=$CONTRACT_ID"
    echo "VITE_RPC_URL=$RPC_URL"
    echo "VITE_NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE"
    if [[ "$NETWORK" == "testnet" ]]; then
      # Native XLM Stellar Asset Contract on testnet.
      echo "VITE_TOKEN_ADDRESS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
    else
      echo "VITE_TOKEN_ADDRESS="
    fi
  } >"$WEB_ENV"
  echo "Wrote $WEB_ENV"
fi

cat <<EOF

Next steps
  1. Start the dApp:   npm install && npm run dev
  2. Configure keeper: ./scripts/configure-keeper.sh   (optional)
  3. Verify on chain:  stellar contract invoke \\
       --id $CONTRACT_ID --source $IDENTITY --network $NETWORK \\
       -- get_plan_count

Explorer: https://stellar.expert/explorer/$([[ "$NETWORK" == "mainnet" ]] && echo public || echo testnet)/contract/$CONTRACT_ID
EOF
