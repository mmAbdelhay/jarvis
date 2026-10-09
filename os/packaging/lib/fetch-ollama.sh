#!/usr/bin/env bash
# fetch-ollama.sh DEST — upstream Ollama (bin/ollama, lib/ollama/) in DEST,
# verified against the SHA-256 pinned in jarvis-ollama/ollama.env.
#   OLLAMA_ENV_FILE  pin file;  OLLAMA_TARBALL  use this file (tests);
#   OLLAMA_CACHE_DIR download cache (default ~/.cache/jarvis-build; CI caches it)
# A cached tarball that fails the check is deleted.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../jarvis-ollama/ollama.env
. "${OLLAMA_ENV_FILE:-$here/../jarvis-ollama/ollama.env}"
dest=$1
cache=${OLLAMA_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/jarvis-build}
if [ -n "${OLLAMA_TARBALL:-}" ]; then
  tarball=$OLLAMA_TARBALL from_cache=false
else
  tarball=$cache/ollama-${OLLAMA_VERSION}-${OLLAMA_ASSET} from_cache=true
  if [ ! -f "$tarball" ]; then
    mkdir -p "$cache"
    curl -fsSL --retry 3 -o "$tarball.part" \
      "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/${OLLAMA_ASSET}"
    mv "$tarball.part" "$tarball"
  fi
fi
actual=$(sha256sum "$tarball" | cut -d' ' -f1)
if [ "$actual" != "$OLLAMA_SHA256" ]; then
  echo "fetch-ollama: checksum mismatch for $tarball" >&2
  echo "  expected $OLLAMA_SHA256" >&2
  echo "  actual   $actual" >&2
  if [ "$from_cache" = true ]; then rm -f "$tarball"; fi
  exit 1
fi
mkdir -p "$dest"
case $OLLAMA_ASSET in
  *.tar.zst) tar --zstd -xf "$tarball" -C "$dest" ;;
  *.tgz|*.tar.gz) tar -xzf "$tarball" -C "$dest" ;;
  *) echo "fetch-ollama: unknown archive type $OLLAMA_ASSET" >&2; exit 1 ;;
esac
[ -x "$dest/bin/ollama" ] || { echo "fetch-ollama: no bin/ollama in $OLLAMA_ASSET" >&2; exit 1; }
