#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=oxipng
REVISION=628e241e23f368097883807fa6e985ccf7c00357
PREFIX=/opt/hereisit-native/oxipng
SOURCE="$(checkout_source "$NAME" https://github.com/oxipng/oxipng.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" LICENSE

cargo build --manifest-path "$SOURCE/Cargo.toml" --release --locked
cargo metadata --manifest-path "$SOURCE/Cargo.toml" --format-version 1 --locked \
  >"$BUILD_METADATA_ROOT/oxipng-cargo-metadata.json"
install -D -m 0755 "$SOURCE/target/release/oxipng" "$PREFIX/bin/oxipng"
install -D -m 0644 "$SOURCE/Cargo.lock" "$LICENSE_ROOT/oxipng/Cargo.lock"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "cargo release locked; live preset -o 3 --strip safe" "$PREFIX"
