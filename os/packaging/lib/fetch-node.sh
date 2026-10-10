#!/usr/bin/env bash
# fetch-node.sh DEST — put Node's linux-x64 runtime (bin/node, npm, LICENSE) in
# DEST, verified against the SHA-256 pinned in jarvisd/node.env.
#
#   NODE_ENV_FILE   pin file (default: ../jarvisd/node.env)
#   NODE_TARBALL    use this tarball instead of the cache/download (tests)
#   NODE_CACHE_DIR  download cache (default: ~/.cache/jarvis-build; CI caches it)
#
# A cached tarball that fails the check is deleted, so a poisoned or
# truncated cache cannot fail every later build the same way.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../jarvisd/node.env
. "${NODE_ENV_FILE:-$here/../jarvisd/node.env}"
dest=$1
name="node-v${NODE_VERSION}-linux-x64.tar.xz"
cache=${NODE_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/jarvis-build}

if [ -n "${NODE_TARBALL:-}" ]; then
  tarball=$NODE_TARBALL
  from_cache=false
else
  tarball=$cache/$name
  from_cache=true
  if [ ! -f "$tarball" ]; then
    mkdir -p "$cache"
    curl -fsSL --retry 3 -o "$tarball.part" "https://nodejs.org/dist/v${NODE_VERSION}/$name"
    mv "$tarball.part" "$tarball"
  fi
fi

actual=$(sha256sum "$tarball" | cut -d' ' -f1)
if [ "$actual" != "$NODE_SHA256" ]; then
  echo "fetch-node: checksum mismatch for $tarball" >&2
  echo "  expected $NODE_SHA256" >&2
  echo "  actual   $actual" >&2
  if [ "$from_cache" = true ]; then rm -f "$tarball"; fi
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xJf "$tarball" -C "$tmp"
src="$tmp/node-v${NODE_VERSION}-linux-x64"
install -D -m0755 "$src/bin/node" "$dest/bin/node"
install -D -m0644 "$src/LICENSE" "$dest/LICENSE"
# Plan Y §5.5: jarvisd installs account CLIs with its own npm.
if [ ! -f "$src/lib/node_modules/npm/bin/npm-cli.js" ]; then
  echo "fetch-node: $name carries no npm" >&2
  exit 1
fi
mkdir -p "$dest/lib/node_modules"
rm -rf "$dest/lib/node_modules/npm"
cp -R "$src/lib/node_modules/npm" "$dest/lib/node_modules/npm"
ln -sfn ../lib/node_modules/npm/bin/npm-cli.js "$dest/bin/npm"
