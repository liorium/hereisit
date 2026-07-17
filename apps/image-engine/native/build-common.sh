#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="${SOURCE_ROOT:-/opt/hereisit-sources}"
BUILD_METADATA_ROOT="${BUILD_METADATA_ROOT:-/build-metadata}"
LICENSE_ROOT="${LICENSE_ROOT:-/licenses}"

checkout_source() {
  local name="$1"
  local repository="$2"
  local revision="$3"
  local destination="${SOURCE_ROOT}/${name}"
  install -d -m 0755 "$SOURCE_ROOT" "$BUILD_METADATA_ROOT" "$LICENSE_ROOT/$name"
  git init -q "$destination"
  git -C "$destination" remote add origin "$repository"
  git -C "$destination" fetch --depth 1 origin "$revision"
  git -C "$destination" checkout -q --detach FETCH_HEAD
  test "$(git -C "$destination" rev-parse HEAD)" = "$revision"
  printf '%s\n' "$destination"
}

copy_notices() {
  local name="$1"
  local source="$2"
  shift 2
  local notice
  for notice in "$@"; do
    test -f "$source/$notice"
    install -D -m 0644 "$source/$notice" "$LICENSE_ROOT/$name/$notice"
  done
}

finalize_source() {
  local source="$1"
  rm -rf "$source/.git"
  test ! -e "$source/.git"
}

record_build() {
  local name="$1"
  local revision="$2"
  local flags="$3"
  local install_root="$4"
  local records
  records="$(mktemp)"
  find "$install_root" -type f -print0 \
    | sort -z \
    | while IFS= read -r -d '' file; do
        printf '%s\t%s\n' "$(sha256sum "$file" | cut -d ' ' -f 1)" "$file"
      done >"$records"
  jq -Rn \
    --arg name "$name" \
    --arg revision "$revision" \
    --arg flags "$flags" \
    --arg compiler "$(cc --version 2>/dev/null | head -n 1 || true)" \
    --arg rustc "$(rustc --version 2>/dev/null || true)" \
    --arg cargo "$(cargo --version 2>/dev/null || true)" \
    --slurpfile artifacts <(jq -Rn '[inputs | split("\t") | {sha256: .[0], path: .[1]}]' <"$records") \
    '{
      schemaVersion: 1,
      name: $name,
      revision: $revision,
      flags: $flags,
      compiler: $compiler,
      rustc: $rustc,
      cargo: $cargo,
      artifacts: $artifacts[0]
    }' >"$BUILD_METADATA_ROOT/$name.json"
  rm -f "$records"
}
