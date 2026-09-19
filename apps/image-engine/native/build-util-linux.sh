#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=util-linux
# Stable 2.41 branch, including the post-release header and symlink-flag fixes.
REVISION=ba905a1874959c70fd706aa7d49df61076864e0a
PREFIX=/opt/hereisit-native/util-linux
SOURCE="$(checkout_source "$NAME" https://github.com/util-linux/util-linux.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" README.licensing \
  Documentation/licenses/COPYING.LGPL-2.1-or-later \
  Documentation/licenses/COPYING.BSD-2-Clause \
  Documentation/licenses/COPYING.BSD-3-Clause \
  Documentation/licenses/COPYING.MIT lib/crc64.c lib/xxhash.c

meson setup "$SOURCE/build" "$SOURCE" \
  --buildtype=release --prefix="$PREFIX" --libdir=lib \
  -Dauto_features=disabled -Ddefault_library=shared \
  -Dbuild-libblkid=enabled -Dbuild-libmount=enabled -Dprogram-tests=false
ninja -C "$SOURCE/build" -j "$(nproc)" \
  libblkid/libblkid.so.1.1.0 libmount/libmount.so.1.1.0
for library in blkid mount; do
  install -Dm755 "$SOURCE/build/lib$library/lib$library.so.1.1.0" "$PREFIX/lib/lib$library.so.1.1.0"
  ln -s "lib$library.so.1.1.0" "$PREFIX/lib/lib$library.so.1"
  ln -s "lib$library.so.1" "$PREFIX/lib/lib$library.so"
  install -Dm644 "$SOURCE/build/meson-private/$library.pc" "$PREFIX/lib/pkgconfig/$library.pc"
done
install -Dm644 "$SOURCE/build/libblkid/blkid.h" "$PREFIX/include/blkid/blkid.h"
install -Dm644 "$SOURCE/build/libmount/libmount.h" "$PREFIX/include/libmount/libmount.h"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export LD_LIBRARY_PATH="$PREFIX/lib"
test "$(pkg-config --modversion blkid)" = "2.41.6"
test "$(pkg-config --modversion mount)" = "2.41.6"
python3 - "$PREFIX" <<'PY'
import ctypes, sys
for name, symbol, extra in [("blkid", "blkid_get_library_version", [None]), ("mount", "mnt_get_library_version", [])]:
    lib = ctypes.CDLL(f"{sys.argv[1]}/lib/lib{name}.so")
    version = ctypes.c_char_p()
    assert getattr(lib, symbol)(ctypes.byref(version), *extra) > 0
    assert version.value == b"2.41.6", (name, version.value)
PY
test ! -d "$PREFIX/bin"
test ! -d "$PREFIX/sbin"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "release shared libblkid libmount only no-programs" "$PREFIX"
