#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INPUT_DIR="$ROOT_DIR/native/input"
OUT_NODE="$INPUT_DIR/index.node"

pushd "$INPUT_DIR" >/dev/null

cargo build --release --target aarch64-apple-darwin
cargo build --release --target x86_64-apple-darwin

ARM_LIB="$INPUT_DIR/target/aarch64-apple-darwin/release/libhermes_input.dylib"
X64_LIB="$INPUT_DIR/target/x86_64-apple-darwin/release/libhermes_input.dylib"

lipo -create -output "$OUT_NODE" "$ARM_LIB" "$X64_LIB"

echo "Built universal addon: $OUT_NODE"

popd >/dev/null
