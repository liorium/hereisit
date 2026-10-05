#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=expat
REVISION=a76b1174c1ea52abb639a4c69d52b630a8a106a2
PREFIX=/opt/hereisit-native/expat
SOURCE="$(checkout_source "$NAME" https://github.com/libexpat/libexpat.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" expat/COPYING

cmake -S "$SOURCE/expat" -B "$SOURCE/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DEXPAT_SHARED_LIBS=ON \
  -DEXPAT_BUILD_TESTS=ON \
  -DEXPAT_BUILD_TOOLS=OFF \
  -DEXPAT_BUILD_EXAMPLES=OFF \
  -DEXPAT_BUILD_DOCS=OFF \
  -DEXPAT_BUILD_FUZZERS=OFF \
  -DEXPAT_BUILD_PKGCONFIG=ON
cmake --build "$SOURCE/build" --parallel "$(nproc)"
ctest --test-dir "$SOURCE/build" --output-on-failure
cmake --install "$SOURCE/build"
test "$(PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" pkg-config --modversion expat)" = "2.9.0"
python3 -c 'import ctypes, sys; lib = ctypes.CDLL(sys.argv[1]); lib.XML_ExpatVersion.restype = ctypes.c_char_p; assert lib.XML_ExpatVersion() == b"expat_2.9.0"' "$PREFIX/lib/libexpat.so"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "release shared tested no-tools no-examples" "$PREFIX"
