#!/usr/bin/env bash
#
# Run a full SubStream lifecycle against a deployed contract:
#   create plan -> subscribe -> wait -> charge -> cancel/refund -> pause plan
#
# Usage:
#   ./scripts/demo.sh
#   ./scripts/demo.sh --interval 3600 --cycles 3 --amount 10000000
#   ./scripts/demo.sh --contract C... --identity my-key
#
# Amounts are in stroops. 1 XLM = 10,000,000 stroops.
#
# Environment:
#   STELLAR_IDENTITY   key used to sign (default: substream-deployer)
#   CONTRACT_ID        overrides apps/web/.env
#   TOKEN              SAC token address (default: testnet native XLM)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ENV="$ROOT/apps/web/.env"

read_env() {
  local key="$1"
  [[ -f "$WEB_ENV" ]] || return 0
  grep -E "^${key}=" "$WEB_ENV" | tail -n1 | cut -d= -f2- || true
}

NETWORK="testnet"
IDENTITY="${STELLAR_IDENTITY:-substream-deployer}"
CONTRACT_ID="${CONTRACT_ID:-$(read_env VITE_CONTRACT_ID)}"
TOKEN="${TOKEN:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"
AMOUNT="${AMOUNT:-10000000}"      # 1 XLM
INTERVAL="${INTERVAL:-60}"        # seconds between charges
GRACE_PERIOD="${GRACE_PERIOD:-3600}"
CYCLES="${CYCLES:-2}"
NO_WAIT=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --contract) CONTRACT_ID="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --amount) AMOUNT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --grace-period) GRACE_PERIOD="$2"; shift 2 ;;
    --cycles) CYCLES="$2"; shift 2 ;;
    --no-wait) NO_WAIT=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

for pair in "AMOUNT:$AMOUNT" "INTERVAL:$INTERVAL" "GRACE_PERIOD:$GRACE_PERIOD" "CYCLES:$CYCLES"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  [[ "$value" =~ ^[0-9]+$ ]] || { echo "$name must be a whole number" >&2; exit 1; }
done

if ! command -v stellar >/dev/null 2>&1; then
  echo "The Stellar CLI is required. Install it and re-run this script." >&2
  exit 1
fi

if [[ -z "$CONTRACT_ID" ]]; then
  echo "No contract id. Deploy first or pass --contract C..." >&2
  exit 1
fi

if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  echo "Unknown Stellar identity '$IDENTITY'. Create one with:" >&2
  echo "  stellar keys generate $IDENTITY --fund" >&2
  exit 1
fi

MERCHANT="$(stellar keys address "$IDENTITY")"
EXPLORER="https://stellar.expert/explorer/$([[ "$NETWORK" == "mainnet" ]] && echo public || echo testnet)"

invoke() {
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- "$@"
}

count() {
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$IDENTITY" \
    --network "$NETWORK" \
    -- "$1" 2>/dev/null | tail -n1 | tr -d '[:space:]'
}

echo "SubStream demo"
echo "  contract : $CONTRACT_ID"
echo "  merchant : $MERCHANT"
echo "  network  : $NETWORK"
echo "  terms    : $AMOUNT stroops every ${INTERVAL}s, ${CYCLES} cycles prepaid"
echo

before_plans="$(count get_plan_count)"
[[ "$before_plans" =~ ^[0-9]+$ ]] || { echo "Could not read plan count: '$before_plans'" >&2; exit 1; }

echo "==> 1/5 Create plan"
invoke create_plan \
  --merchant "$MERCHANT" \
  --token "$TOKEN" \
  --amount "$AMOUNT" \
  --interval "$INTERVAL" \
  --grace_period "$GRACE_PERIOD"
PLAN_ID="$((before_plans + 1))"

before_subs="$(count get_subscription_count)"
[[ "$before_subs" =~ ^[0-9]+$ ]] || { echo "Could not read subscription count: '$before_subs'" >&2; exit 1; }

echo
echo "==> 2/5 Subscribe to plan #$PLAN_ID with $CYCLES cycles prepaid"
invoke subscribe \
  --subscriber "$MERCHANT" \
  --plan_id "$PLAN_ID" \
  --cycles_prepaid "$CYCLES"
SUBSCRIPTION_ID="$((before_subs + 1))"

echo
if [[ "$NO_WAIT" == "1" ]]; then
  echo "==> 3/5 Skipping wait (--no-wait)"
else
  echo "==> 3/5 Waiting $((INTERVAL + 5))s for the first cycle to become due"
  sleep "$((INTERVAL + 5))"
fi

echo
echo "==> 4/5 Charge subscription #$SUBSCRIPTION_ID (permissionless)"
invoke charge --subscription_id "$SUBSCRIPTION_ID"

echo
echo "==> Subscription state"
invoke get_subscription --subscription_id "$SUBSCRIPTION_ID"

echo
echo "==> 5/5 Cancel and refund unused escrow, then pause the plan"
invoke cancel --subscriber "$MERCHANT" --subscription_id "$SUBSCRIPTION_ID"
invoke update_plan \
  --merchant "$MERCHANT" \
  --plan_id "$PLAN_ID" \
  --amount "$AMOUNT" \
  --interval "$INTERVAL" \
  --grace_period "$GRACE_PERIOD" \
  --active false

echo
echo "Demo complete."
echo "  plan         : #$PLAN_ID"
echo "  subscription : #$SUBSCRIPTION_ID"
echo "  explorer     : $EXPLORER/contract/$CONTRACT_ID"
echo
echo "Transaction links are printed above. The plan was paused so it does not"
echo "linger in the public market."
