#!/usr/bin/env bash
set -euo pipefail

root="${1:?runtime root is required}"
shift

mkdir -p "$root/usr/lib" "$root/usr/share/doc" "$root/var/lib/dpkg/status.d"
declare -A packages=()
dependencies="$(mktemp)"
trap 'rm -f "$dependencies"' EXIT

if ! find "$@" -type f -print0 | while IFS= read -r -d '' artifact; do
  [[ "$(od -An -tx1 -N4 "$artifact" | tr -d ' \n')" == 7f454c46 ]] || continue
  if ! output="$(ldd "$artifact" 2>&1)"; then
    [[ "$output" == *"not a dynamic executable"* || "$output" == *"statically linked"* ]] && continue
    printf '%s\n' "$output" >&2
    exit 1
  fi
  [[ "$output" != *"not found"* ]] || { printf '%s\n' "$output" >&2; exit 1; }
  awk '$2 == "=>" && $3 ~ /^\// { print $3; next } $1 ~ /^\// { print $1 }' <<<"$output"
done | sort -u >"$dependencies"; then
  exit 1
fi

while IFS= read -r library; do
  [[ "$library" == "$root"/* || "$library" == /opt/* ]] && continue
  resolved="$(realpath "$library")"
  if ! ownership="$(dpkg-query -S "$resolved" 2>&1)"; then
    printf '%s\n' "$ownership" >&2
    exit 1
  fi
  owner="${ownership%%:*}"
  [[ -n "$owner" ]] || { printf 'no package owns %s\n' "$resolved" >&2; exit 1; }

  destination="$library"
  [[ "$destination" == /lib/* || "$destination" == /lib64/* ]] && destination="/usr$destination"
  install -Dm755 "$resolved" "$root$destination"

  resolved_destination="$resolved"
  [[ "$resolved_destination" == /lib/* || "$resolved_destination" == /lib64/* ]] \
    && resolved_destination="/usr$resolved_destination"
  [[ "$resolved_destination" == "$destination" ]] \
    || install -Dm755 "$resolved" "$root$resolved_destination"
  packages["$owner"]=1
done <"$dependencies"

[[ -f "$root/etc/os-release" ]] && packages[base-files]=1
[[ -f "$root/etc/ssl/certs/ca-certificates.crt" ]] && packages[ca-certificates]=1
[[ -e "$root/usr/lib/locale/C.utf8" || -f "$root/etc/nsswitch.conf" ]] && packages[libc-bin]=1

printf '%s\n' "${!packages[@]}" | sort >"$dependencies"
while IFS= read -r package; do
  [[ -n "$package" ]] || continue
  dpkg-query -s "$package" >"$root/var/lib/dpkg/status.d/$package"
  version="$(dpkg-query -W -f='${Version}' "$package")"
  printf '%s\t%s\n' "$package" "$version"
  copyright="/usr/share/doc/$package/copyright"
  [[ -f "$copyright" ]] || { printf 'missing copyright for %s\n' "$package" >&2; exit 1; }
  install -Dm644 "$copyright" "$root/usr/share/doc/$package/copyright"
done <"$dependencies"
