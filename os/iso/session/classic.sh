#!/usr/bin/env bash
# os/iso/session/classic.sh --debs DIR [--out DIR] — headless labwc test of the
# automatic classic fallback, the classic session and the Super-key routing
# (M4 contracts §2). Unprivileged debian:trixie container; Linux CI only.
set -euo pipefail
debs="" out=""
while [ $# -gt 0 ]; do
  case $1 in
    --debs) debs=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "classic.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$debs" ] || { echo "usage: classic.sh --debs DIR [--out DIR]" >&2; exit 2; }
repo=$(cd "$(dirname "$0")/../../.." && pwd)
debs=$(cd "$debs" && pwd)
out=${out:-$(mktemp -d)}
mkdir -p "$out"; out=$(cd "$out" && pwd)
compgen -G "$debs/jarvis-session_*.deb" >/dev/null || { echo "classic.sh: no jarvis-session .deb in $debs" >&2; exit 1; }
exec docker run --rm --platform linux/amd64 -e DEBIAN_FRONTEND=noninteractive \
  -v "$repo:/src:ro" -v "$debs:/debs:ro" -v "$out:/out" \
  debian:trixie bash /src/os/iso/session/in-container-classic.sh
