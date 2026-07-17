#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=jpegli
REVISION=031a0077f5799a6041004267fc12b956c1f52a20
PREFIX=/opt/benchmark/jpegli
SOURCE="$(checkout_source "$NAME" https://github.com/google/jpegli.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" LICENSE PATENTS
git -C "$SOURCE" submodule update --init --recursive --depth 1

CC=cc CXX=c++ cmake -S "$SOURCE" -B "$SOURCE/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DJPEGLI_ENABLE_DEVTOOLS=ON \
  -DJPEGLI_WARNINGS_AS_ERRORS=ON
cmake --build "$SOURCE/build" --parallel "$(nproc)" --target cjpegli
install -D -m 0755 "$SOURCE/build/tools/cjpegli" "$PREFIX/bin/cjpegli"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "benchmark release tests-skipped" "$PREFIX"
