#!/usr/bin/env bash
set -euo pipefail

root="${1:?runtime root is required}"
shift

mkdir -p "$root/usr/lib" "$root/usr/share/doc" "$root/var/lib/dpkg/status.d"
packages=()

while IFS= read -r library; do
  [[ "$library" == "$root"/* || "$library" == /opt/* ]] && continue
  resolved="$(realpath "$library")"
  owner="$(dpkg-query -S "$resolved" | head -n 1 | cut -d: -f1)"
  case "$owner" in
    libc6|libgcc-s1|libgomp1|libssl3t64|libstdc++6|libzstd1|zlib1g) continue ;;
  esac
  destination="$library"
  [[ "$destination" == /lib/* ]] && destination="/usr$destination"
  install -Dm755 "$resolved" "$root$destination"
  packages+=("$owner")
done < <(
  find "$@" -type f -print0 | while IFS= read -r -d '' artifact; do
    [[ "$(od -An -tx1 -N4 "$artifact" | tr -d ' \n')" == 7f454c46 ]] || continue
    output="$(ldd "$artifact" 2>&1)" || {
      [[ "$output" == *"not a dynamic executable"* || "$output" == *"statically linked"* ]] && continue
      printf '%s\n' "$output" >&2
      exit 1
    }
    [[ "$output" != *"not found"* ]] || { printf '%s\n' "$output" >&2; exit 1; }
    awk '/=> \// { print $3 } /^\// { print $1 }' <<<"$output"
  done | sort -u
)

for package in $(printf '%s\n' "${packages[@]}" | sort -u); do
  dpkg-query -s "$package" >"$root/var/lib/dpkg/status.d/$package"
  version="$(dpkg-query -W -f='${Version}' "$package")"
  printf '%s\t%s\n' "$package" "$version"
  if [[ -f "/usr/share/doc/$package/copyright" ]]; then
    install -Dm644 "/usr/share/doc/$package/copyright" "$root/usr/share/doc/$package/copyright"
  fi
done
