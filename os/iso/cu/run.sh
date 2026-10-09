#!/usr/bin/env bash
# os/iso/cu/run.sh --debs DIR [--out DIR] — the computer-use GUI test (v1.1
# design §2) in a nested headless labwc: an unprivileged debian:trixie
# container with the real packages, GIMP and a scripted vision model. Linux
# only: the owner's Linux box (os/iso/dev/remote.sh) or CI, never the dev Mac.
set -euo pipefail
debs="" out=""
while [ $# -gt 0 ]; do
  case $1 in
    --debs) debs=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    *) echo "run.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$debs" ] || { echo "usage: run.sh --debs DIR [--out DIR]" >&2; exit 2; }
[ "$(uname -s)" = Linux ] || { echo "run.sh: Linux only; from the Mac use os/iso/dev/remote.sh" >&2; exit 2; }
repo=$(cd "$(dirname "$0")/../../.." && pwd)
debs=$(cd "$debs" && pwd)
out=${out:-$(mktemp -d)}
mkdir -p "$out"; out=$(cd "$out" && pwd)
for p in jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-cu jarvis-i18n jarvis-ui jarvis-lock jarvis-session; do
  compgen -G "$debs/${p}_*.deb" >/dev/null || { echo "run.sh: no $p .deb in $debs" >&2; exit 1; }
done
exec docker run --rm --platform linux/amd64 -e DEBIAN_FRONTEND=noninteractive \
  -v "$repo:/src:ro" -v "$debs:/debs:ro" -v "$out:/out" \
  debian:trixie bash /src/os/iso/cu/in-container.sh
