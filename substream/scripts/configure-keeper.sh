#!/usr/bin/env bash
#
# Write services/keeper/.env using the same Stellar CLI identity that deployed
# the contract. The secret key is copied into the file but is never printed.
#
# Usage:
#   ./scripts/configure-keeper.sh
#   ./scripts/configure-keeper.sh <CONTRACT_ID>
#
# Environment:
#   STELLAR_IDENTITY   Stellar CLI identity to use (default: substream-deployer)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ENV="$ROOT/apps/web/.env"
KEEPER_ENV="$ROOT/services/keeper/.env"
IDENTITY="${STELLAR_IDENTITY:-substream-deployer}"

read_env() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- || true
}

CONTRACT_ID="${1:-${CONTRACT_ID:-$(read_env "$WEB_ENV" VITE_CONTRACT_ID)}}"
RPC_URL="${RPC_URL:-$(read_env "$WEB_ENV" VITE_RPC_URL)}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-$(read_env "$WEB_ENV" VITE_NETWORK_PASSPHRASE)}"

RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

if ! command -v stellar >/dev/null 2>&1; then
  echo "The Stellar CLI is required. Install it, then re-run this script." >&2
  exit 1
fi

if [[ -z "$CONTRACT_ID" ]]; then
  echo "No contract id found." >&2
  echo "Deploy first with ./scripts/deploy.sh testnet, or pass an id:" >&2
  echo "  ./scripts/configure-keeper.sh C..." >&2
  exit 1
fi

if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  echo "Stellar CLI identity '$IDENTITY' does not exist." >&2
  echo "Create and fund one for testnet with:" >&2
  echo "  stellar keys generate $IDENTITY --fund" >&2
  exit 1
fi

ADDRESS="$(stellar keys address "$IDENTITY")"
SECRET="$(stellar keys secret "$IDENTITY")"

umask 077
cat >"$KEEPER_ENV" <<EOF
CONTRACT_ID=$CONTRACT_ID
RPC_URL=$RPC_URL
NETWORK_PASSPHRASE="$NETWORK_PASSPHRASE"
KEEPER_SECRET=$SECRET
POLL_INTERVAL_MS=30000
MAX_SUBSCRIPTIONS=200
DRY_RUN=0
EOF
chmod 600 "$KEEPER_ENV"

cat <<EOF
Wrote $KEEPER_ENV (mode 600, gitignored).

  contract : $CONTRACT_ID
  keeper   : $ADDRESS
  network  : $RPC_URL

The secret key is stored only in that file and was not printed.

Next:
  npm run keeper:once      # one pass, then exit
  npm run keeper:dry-run   # log what would be charged, send nothing
  npm run keeper           # run continuously
EOF

# On testnet, warn if the keeper account has never been funded.
if [[ "$RPC_URL" == *"testnet"* ]]; then
  if ! curl -fsS -m 10 "https://horizon-testnet.stellar.org/accounts/$ADDRESS" \
    >/dev/null 2>&1; then
    echo
    echo "Note: $ADDRESS is not funded on testnet yet. Fund it with:"
    echo "  curl \"https://friendbot.stellar.org?addr=$ADDRESS\""
  fi
fi
