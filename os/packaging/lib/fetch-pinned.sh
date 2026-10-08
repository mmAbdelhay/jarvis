#!/usr/bin/env bash
# fetch-pinned.sh URL SHA256 NAME — download URL once into the build cache as
# NAME, verify SHA256 and print the file's path. A cached file that fails the
# check is deleted (the next run downloads it again).
#   PINNED_FILE         use this file instead of downloading (tests)
#   JARVIS_BUILD_CACHE  cache dir (default ~/.cache/jarvis-build; CI caches it)
set -euo pipefail
url=$1 sha=$2 name=$3
[[ $sha =~ ^[0-9a-f]{64}$ ]] || { echo "fetch-pinned: $name has no valid sha256 pin" >&2; exit 1; }
cache=${JARVIS_BUILD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/jarvis-build}
if [ -n "${PINNED_FILE:-}" ]; then
  file=$PINNED_FILE from_cache=false
else
  file=$cache/$name from_cache=true
  if [ ! -f "$file" ]; then
    mkdir -p "$cache"
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
fi
actual=$(sha256sum "$file" | cut -d' ' -f1)
if [ "$actual" != "$sha" ]; then
  echo "fetch-pinned: checksum mismatch for $name" >&2
  echo "  expected $sha" >&2
  echo "  actual   $actual" >&2
  if [ "$from_cache" = true ]; then rm -f "$file"; fi
  exit 1
fi
printf '%s\n' "$file"
