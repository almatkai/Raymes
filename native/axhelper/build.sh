#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AX_DIR="$ROOT_DIR/native/axhelper"
OUT_BIN="$AX_DIR/axhelper"

swiftc "$AX_DIR/main.swift" -O -o "$OUT_BIN"
codesign --force --sign - "$OUT_BIN"

echo "Built axhelper: $OUT_BIN"
