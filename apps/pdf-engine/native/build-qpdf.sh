#!/usr/bin/env bash
set -euo pipefail

LOCK=/usr/local/src/sources.lock.json
VERSION="$(jq --exit-status --raw-output '.sources | if length == 1 and .[0].name == "qpdf" then .[0].version else empty end' "$LOCK")"
URL="$(jq --exit-status --raw-output '.sources[0].url' "$LOCK")"
SHA256="$(jq --exit-status --raw-output '.sources[0].sha256' "$LOCK")"
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
test "$("$PREFIX/bin/qpdf" --version | head -n 1)" = "qpdf version $VERSION"
