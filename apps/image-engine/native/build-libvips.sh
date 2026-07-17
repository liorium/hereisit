#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=libvips
REVISION=e01a4797cabe77d457fdfa7d776b7a7e7ca6d6a7
PREFIX=/opt/hereisit-native/libvips
SOURCE="$(checkout_source "$NAME" https://github.com/libvips/libvips.git "$REVISION")"
copy_notices "$NAME" "$SOURCE" LICENSE

export PKG_CONFIG_PATH="/opt/hereisit-native/mozjpeg/lib/pkgconfig:/opt/hereisit-native/libwebp/lib/pkgconfig"
export LD_LIBRARY_PATH="/opt/hereisit-native/libwebp/lib"
meson setup "$SOURCE/build" "$SOURCE" \
  --buildtype=release \
  --prefix="$PREFIX" \
  --libdir=lib \
  -Dauto_features=disabled \
  -Ddeprecated=false \
  -Dexamples=false \
  -Dcplusplus=true \
  -Ddocs=false \
  -Dcpp-docs=false \
  -Dmodules=disabled \
  -Dintrospection=disabled \
  -Djpeg=enabled \
  -Dpng=enabled \
  -Dwebp=enabled \
  -Dlcms=enabled \
  -Dexif=enabled \
  -Dzlib=enabled \
  -Dimagequant=disabled \
  -Dquantizr=disabled \
  -Dmagick=disabled \
  -Dnsgif=false \
  -Dppm=false \
  -Danalyze=false \
  -Dradiance=false
meson compile -C "$SOURCE/build" -j "$(nproc)"
meson install -C "$SOURCE/build"
finalize_source "$SOURCE"
record_build "$NAME" "$REVISION" "release shared no-modules jpeg png webp lcms exif only" "$PREFIX"
