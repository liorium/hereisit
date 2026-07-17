#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=libwebp
REVISION=4fa21912338357f89e4fd51cf2368325b59e9bd9
PREFIX=/opt/hereisit-native/libwebp
SOURCE="$(checkout_source "$NAME" https://github.com/webmproject/libwebp.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" COPYING PATENTS

cmake -S "$SOURCE" -B "$SOURCE/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_SHARED_LIBS=ON \
  -DWEBP_ENABLE_SIMD=ON \
  -DWEBP_BUILD_CWEBP=ON \
  -DWEBP_BUILD_DWEBP=ON \
  -DWEBP_BUILD_ANIM_UTILS=OFF \
  -DWEBP_BUILD_EXTRAS=OFF \
  -DWEBP_BUILD_GIF2WEBP=OFF \
  -DWEBP_BUILD_IMG2WEBP=OFF \
  -DWEBP_BUILD_LIBWEBPMUX=ON \
  -DWEBP_BUILD_VWEBP=OFF \
  -DWEBP_BUILD_WEBPINFO=OFF \
  -DWEBP_BUILD_WEBPMUX=OFF
cmake --build "$SOURCE/build" --parallel "$(nproc)"
cmake --install "$SOURCE/build"
strip "$PREFIX/bin/cwebp" "$PREFIX/bin/dwebp"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "release shared simd cwebp dwebp minimal" "$PREFIX"
