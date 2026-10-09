#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/scripts/ensure-yespower.sh"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required to build the YesPower WASM module."
  exit 1
}

mkdir -p "$ROOT/web/src/generated"

docker run --rm \
  -v "$ROOT:/src" \
  -w /src \
  emscripten/emsdk:latest \
  emcc \
    wasm/yespower_wasm.c \
    vendor/yespower/yespower-ref.c \
    vendor/yespower/sha256.c \
    -Ivendor/yespower \
    -O3 \
    -s WASM=1 \
    -s SINGLE_FILE=1 \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s ENVIRONMENT=worker \
    -s EXPORTED_RUNTIME_METHODS=HEAPU8 \
    -s EXPORTED_FUNCTIONS='["_yp_init","_yp_hash","_yp_free","_malloc","_free"]' \
    -o web/src/generated/yespower.mjs

echo "Built:"
ls -lh "$ROOT/web/src/generated/yespower.mjs"
