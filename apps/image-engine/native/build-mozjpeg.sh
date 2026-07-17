#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=mozjpeg
REVISION=a2d2907ff023227e80c1e4efa809812410275a12
PREFIX=/opt/hereisit-native/mozjpeg
SOURCE="$(checkout_source "$NAME" https://github.com/mozilla/mozjpeg.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" LICENSE.md README.ijg

cmake -S "$SOURCE" -B "$SOURCE/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_INSTALL_LIBDIR:PATH="$PREFIX/lib" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DENABLE_SHARED=FALSE \
  -DENABLE_STATIC=TRUE \
  -DWITH_JAVA=FALSE \
  -DWITH_SIMD=TRUE \
  -DWITH_TURBOJPEG=FALSE
cmake --build "$SOURCE/build" --parallel "$(nproc)"
cmake --install "$SOURCE/build"

cc -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
  -I"$PREFIX/include" "$(dirname "$0")/jpeg-coeff-verify.c" \
  -L"$PREFIX/lib" -Wl,-Bstatic -ljpeg -Wl,-Bdynamic -lm \
  -o "$PREFIX/bin/jpeg-coeff-verify"
strip "$PREFIX/bin/cjpeg" "$PREFIX/bin/djpeg" "$PREFIX/bin/jpegtran" \
  "$PREFIX/bin/jpeg-coeff-verify"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "release static simd no-java no-turbojpeg" "$PREFIX"
