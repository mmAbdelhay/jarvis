#!/usr/bin/env bash
# os/iso/session/run.sh --debs DIR [--out DIR] — headless labwc session test
# for the lock screen, PAM, idle lock and keybinds (M3 contracts §3, design
# §2 criterion 6). Unprivileged debian:trixie container. Linux CI only: the
# dev Mac's emulated amd64 is too slow for the idle timer, and Wayland/PAM
# tests run in CI.
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
repo=$(cd "$(dirname "$0")/../../.." && pwd)
debs=$(cd "$debs" && pwd)
out=${out:-$(mktemp -d)}
mkdir -p "$out"; out=$(cd "$out" && pwd)
for p in jarvis-ui jarvis-lock jarvis-idle jarvis-session; do
  compgen -G "$debs/${p}_*.deb" >/dev/null || { echo "run.sh: no $p .deb in $debs" >&2; exit 1; }
done
exec docker run --rm --platform linux/amd64 -e DEBIAN_FRONTEND=noninteractive \
  -v "$repo:/src:ro" -v "$debs:/debs:ro" -v "$out:/out" \
  debian:trixie bash /src/os/iso/session/in-container.sh
