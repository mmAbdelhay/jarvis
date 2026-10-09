#!/usr/bin/env bash
# Stage jarvis-ollama: upstream binary, runner (llama-server) + CPU backends
# only (GPU runtimes are hundreds of MB and need drivers the ISO does not ship; see plan gaps).
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
# The upstream runner layout is load-bearing: ollama execs
# /usr/lib/ollama/llama-server (plus llama-quantize) and dlopens the CPU
# backends next to it. Copy every top-level file, preserving SONAME symlinks;
# GPU backends live in subdirectories (skipped) but may also occur at the top.
shopt -s nullglob
mkdir -p "$stage/usr/share/doc/jarvis-ollama/licenses"
for f in "$tmp/up/lib/ollama/"*; do
  name=${f##*/}
  case $name in
    *cuda*|*rocm*|*hip*|*vulkan*|*cublas*|*nvrtc*|*nvidia*) continue ;;
  esac
  [ -d "$f" ] && [ ! -L "$f" ] && continue
  if [ -L "$f" ]; then
    cp -a "$f" "$stage/usr/lib/ollama/"
  elif [ -f "$f" ]; then
    case $name in
      *LICENSE*|*NOTICE*) install -m0644 "$f" "$stage/usr/share/doc/jarvis-ollama/licenses/$name" ;;
      *.so|*.so.*) install -m0644 "$f" "$stage/usr/lib/ollama/$name" ;;
      *) if [ -x "$f" ]; then install -m0755 "$f" "$stage/usr/lib/ollama/$name"; else install -m0644 "$f" "$stage/usr/lib/ollama/$name"; fi ;;
    esac
  fi
done
compgen -G "$stage/usr/lib/ollama/libggml-cpu*.so*" >/dev/null || { echo "jarvis-ollama: no CPU backend in the tarball" >&2; exit 1; }
[ -x "$stage/usr/lib/ollama/llama-server" ] || { echo "jarvis-ollama: no lib/ollama/llama-server runner in the tarball" >&2; exit 1; }
echo usr/lib/ollama > "$stage/.shlibs-libdirs"
install -m0644 "$here/ollama.service" "$stage/usr/lib/systemd/system/ollama.service"
install -m0755 "$here/ollama-wait-ready" "$stage/usr/libexec/jarvis/ollama-wait-ready"
mkdir -p "$stage/usr/share/doc/jarvis-ollama"
echo "Ollama ${OLLAMA_VERSION} (${OLLAMA_ASSET}, sha256 ${OLLAMA_SHA256}), MIT licence." > "$stage/usr/share/doc/jarvis-ollama/UPSTREAM"
