#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$ROOT/vendor/yespower/yespower.h" ]]; then
  echo "Missing vendor/yespower. Run:"
  echo "  git submodule add https://github.com/openwall/yespower.git vendor/yespower"
  exit 1
fi

mkdir -p "$ROOT/web/public/wasm"

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
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s ENVIRONMENT=worker \
    -s EXPORTED_FUNCTIONS='["_yp_init","_yp_hash","_yp_free","_malloc","_free"]' \
    -o web/public/wasm/yespower.js

echo "Built web/public/wasm/yespower.{js,wasm}"
