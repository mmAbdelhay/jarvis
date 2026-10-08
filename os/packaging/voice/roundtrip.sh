#!/usr/bin/env bash
# roundtrip.sh --debs DIR — install jarvis-voice-{engines,models} in a stock
# debian:trixie container and check that every Piper voice, transcribed by
# every Whisper model, comes back in its language (M3 design §2.4, §3.2).
# Linux CI only (needs the ~800 MB packages and real amd64 speed).
set -euo pipefail
debs=""
while [ $# -gt 0 ]; do
  case $1 in
    --debs) debs=$2; shift 2 ;;
    *) echo "roundtrip.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$debs" ] || { echo "usage: roundtrip.sh --debs DIR" >&2; exit 2; }
repo=$(cd "$(dirname "$0")/../../.." && pwd)
debs=$(cd "$debs" && pwd)
for p in jarvis-voice-engines jarvis-voice-models; do
  compgen -G "$debs/${p}_*.deb" >/dev/null || { echo "roundtrip.sh: no $p .deb in $debs" >&2; exit 1; }
done
exec docker run --rm --platform linux/amd64 -e DEBIAN_FRONTEND=noninteractive \
  -v "$repo:/src:ro" -v "$debs:/debs:ro" debian:trixie bash /src/os/packaging/voice/in-container.sh
