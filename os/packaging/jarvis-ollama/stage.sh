#!/usr/bin/env bash
# Stage jarvis-ollama: upstream binary + CPU backends only (GPU runtimes are
# hundreds of MB and need drivers the ISO does not ship; see plan gaps).
set -euo pipefail
stage=$1
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=ollama.env
. "${OLLAMA_ENV_FILE:-$here/ollama.env}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
"$here/../lib/fetch-ollama.sh" "$tmp/up"
mkdir -p "$stage/usr/bin" "$stage/usr/lib/systemd/system" "$stage/usr/libexec/jarvis"
install -m0755 "$tmp/up/bin/ollama" "$stage/usr/bin/ollama"
mkdir -p "$stage/usr/lib/ollama"
# Preserve SONAME symlinks; GPU backends may also occur at the top level.
shopt -s nullglob
for lib in "$tmp/up/lib/ollama/"*.so*; do
  case ${lib##*/} in
    *cuda*|*rocm*|*hip*|*vulkan*|*cublas*|*nvrtc*|*nvidia*) continue ;;
  esac
  [ -f "$lib" ] || continue
  cp -a "$lib" "$stage/usr/lib/ollama/"
  if [ ! -L "$lib" ]; then chmod 0644 "$stage/usr/lib/ollama/${lib##*/}"; fi
done
compgen -G "$stage/usr/lib/ollama/libggml-cpu*.so*" >/dev/null || { echo "jarvis-ollama: no CPU backend in the tarball" >&2; exit 1; }
echo usr/lib/ollama > "$stage/.shlibs-libdirs"
install -m0644 "$here/ollama.service" "$stage/usr/lib/systemd/system/ollama.service"
install -m0755 "$here/ollama-wait-ready" "$stage/usr/libexec/jarvis/ollama-wait-ready"
mkdir -p "$stage/usr/share/doc/jarvis-ollama"
echo "Ollama ${OLLAMA_VERSION} (${OLLAMA_ASSET}, sha256 ${OLLAMA_SHA256}), MIT licence." > "$stage/usr/share/doc/jarvis-ollama/UPSTREAM"
