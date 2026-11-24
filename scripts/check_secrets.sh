#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

if git grep -nE '(^|[^A-Z2-7])S[A-Z2-7]{55}([^A-Z2-7]|$)' -- .; then
  echo "error: a Stellar secret key appears in tracked files" >&2
  exit 1
fi

if git grep -nE 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY' -- .; then
  echo "error: a private key block appears in tracked files" >&2
  exit 1
fi

echo "No tracked secret keys found."
