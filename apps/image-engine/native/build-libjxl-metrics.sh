#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=libjxl-metrics
REVISION=332feb17d17311c748445f7ee75c4fb55cc38530
PREFIX=/opt/benchmark/libjxl
SOURCE="$(checkout_source "$NAME" https://github.com/libjxl/libjxl.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" LICENSE PATENTS
git -C "$SOURCE" submodule update --init --recursive --depth 1

cmake -S "$SOURCE" -B "$SOURCE/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DJPEGXL_ENABLE_TOOLS=ON \
  -DJPEGXL_ENABLE_DEVTOOLS=ON \
  -DJPEGXL_ENABLE_BENCHMARK=OFF \
  -DJPEGXL_ENABLE_EXAMPLES=OFF \
  -DJPEGXL_ENABLE_JNI=OFF \
  -DJPEGXL_ENABLE_MANPAGES=OFF
cmake --build "$SOURCE/build" --parallel "$(nproc)" --target ssimulacra2 butteraugli_main
install -D -m 0755 "$SOURCE/build/tools/ssimulacra2" "$PREFIX/bin/ssimulacra2"
install -D -m 0755 "$SOURCE/build/tools/butteraugli_main" "$PREFIX/bin/butteraugli_main"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "benchmark metrics only" "$PREFIX"
