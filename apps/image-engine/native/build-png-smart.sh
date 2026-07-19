#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=png-smart
REVISION=cfb26aaf3039ac1179d42a66cc7988c8c6feeba9
PREFIX=/opt/hereisit-native/png-smart
MANIFEST="$(dirname "$0")/png-smart/Cargo.toml"
SOURCE="$(checkout_source quantizr https://github.com/DarthSim/quantizr.git "$REVISION")"
copy_notices quantizr "$SOURCE" LICENSE

cargo build --manifest-path "$MANIFEST" --release --locked
cargo metadata --manifest-path "$MANIFEST" --format-version 1 --locked \
  >"$BUILD_METADATA_ROOT/png-smart-cargo-metadata.json"
install -D -m 0755 "$(dirname "$MANIFEST")/target/release/png-smart" "$PREFIX/bin/png-smart"
install -D -m 0644 "$(dirname "$MANIFEST")/Cargo.lock" "$LICENSE_ROOT/quantizr/Cargo.lock"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "cargo release locked; quantizr 1.4.3; png 0.18.0" "$PREFIX"
