#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/vendor/yespower"

if [[ -f "$TARGET/yespower.h" ]]; then
  exit 0
fi

if [[ -d "$ROOT/.git" ]]; then
  echo "Trying to initialize the yespower Git submodule..."
  git -C "$ROOT" submodule update --init --recursive || true
fi

if [[ -f "$TARGET/yespower.h" ]]; then
  exit 0
fi

echo "Fetching Openwall yespower from GitHub..."
mkdir -p "$ROOT/vendor"
rm -rf "$TARGET"
git clone --depth 1 https://github.com/openwall/yespower.git "$TARGET"

[[ -f "$TARGET/yespower.h" ]] || { echo "Failed to fetch yespower source."; exit 1; }
