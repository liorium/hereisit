#!/usr/bin/env bash
set -euo pipefail

VERSION=12.4.0
URL=https://github.com/qpdf/qpdf/releases/download/v12.4.0/qpdf-12.4.0.tar.gz
SHA256=2783a032f443cc886dad41aa6d5fae3dabf23dec00ee7ec2cfb27ef67ebcf529
ARCHIVE=/tmp/qpdf.tar.gz
SOURCE=/tmp/qpdf-source
PREFIX=/opt/qpdf

curl --fail --location --proto '=https' --tlsv1.2 --output "$ARCHIVE" "$URL"
printf '%s  %s\n' "$SHA256" "$ARCHIVE" | sha256sum --check --strict
mkdir "$SOURCE"
tar --extract --gzip --file "$ARCHIVE" --directory "$SOURCE" --strip-components=1
cmake -S "$SOURCE" -B "$SOURCE/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_DOC=OFF \
  -DBUILD_SHARED_LIBS=ON \
  -DBUILD_STATIC_LIBS=OFF \
  -DINSTALL_MANUAL=OFF \
  -DINSTALL_PKGCONFIG=OFF \
  -DINSTALL_CMAKE_PACKAGE=OFF \
  -DINSTALL_EXAMPLES=OFF
cmake --build "$SOURCE/build" --parallel "$(nproc)" --target qpdf
cmake --install "$SOURCE/build" --component lib
install -Dm755 "$SOURCE/build/qpdf/qpdf" "$PREFIX/bin/qpdf"
strip "$PREFIX/bin/qpdf" "$PREFIX/lib/"libqpdf.so.*
install -Dm644 "$SOURCE/LICENSE.txt" /licenses/qpdf/LICENSE.txt
install -Dm644 "$SOURCE/NOTICE.md" /licenses/qpdf/NOTICE.md
test "$("$PREFIX/bin/qpdf" --version | head -n 1)" = "qpdf version 12.4.0"
