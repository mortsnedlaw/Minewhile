#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/scripts/ensure-yespower.sh"

mkdir -p "$ROOT/native"

cc \
  -O3 \
  -std=c11 \
  -I"$ROOT/vendor/yespower" \
  "$ROOT/native/yespower-validator.c" \
  "$ROOT/vendor/yespower/yespower-ref.c" \
  "$ROOT/vendor/yespower/sha256.c" \
  -o "$ROOT/native/yespower-validator"

chmod 0755 "$ROOT/native/yespower-validator"

echo "Built native YesPower validator:"
ls -lh "$ROOT/native/yespower-validator"
