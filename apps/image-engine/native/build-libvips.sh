#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

NAME=libvips
REVISION=24ad4d042940e6bf99a68871ba886ca8847c9c82
PREFIX=/opt/hereisit-native/libvips
SOURCE="$(checkout_source "$NAME" https://github.com/libvips/libvips.git "$REVISION")"
PATCH="$(dirname "$0")/libvips-source-bounds.patch"
PATCH_SHA256=871f811400dbb8cdc6a175245da0a9a5ff53acf1cb231f9aaded862e81d0f90d
printf '%s  %s\n' "$PATCH_SHA256" "$PATCH" | sha256sum --check --status
git -C "$SOURCE" apply --check "$PATCH"
git -C "$SOURCE" apply "$PATCH"
install -m 0644 "$PATCH" "$SOURCE/libvips-source-bounds.patch"
copy_notices "$NAME" "$SOURCE" LICENSE libvips-source-bounds.patch

export PKG_CONFIG_PATH="/opt/hereisit-native/expat/lib/pkgconfig:/opt/hereisit-native/mozjpeg/lib/pkgconfig:/opt/hereisit-native/libwebp/lib/pkgconfig"
export LD_LIBRARY_PATH="/opt/hereisit-native/expat/lib:/opt/hereisit-native/util-linux/lib:/opt/hereisit-native/libwebp/lib"
test "$(pkg-config --modversion expat)" = "2.8.4"
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
jq --arg patchSha256 "$PATCH_SHA256" '. + {patchSha256: $patchSha256}' \
  "$BUILD_METADATA_ROOT/$NAME.json" > "$BUILD_METADATA_ROOT/$NAME.patched.json"
mv "$BUILD_METADATA_ROOT/$NAME.patched.json" "$BUILD_METADATA_ROOT/$NAME.json"
