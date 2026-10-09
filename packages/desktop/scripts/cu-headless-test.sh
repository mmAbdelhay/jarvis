#!/usr/bin/env bash
# packages/desktop/scripts/cu-headless-test.sh
# Runs cu-client.labwc.test.ts against a real labwc (headless backend) and the
# real jarvis-cu built from os/go (Plan U). Linux only. Needs labwc, zenity,
# iproute2 (ss), Go and Node 24 + pnpm with the repo's dependencies installed.
#
#   Run from ~/rafiq-build/v11 on the owner's Linux box, keeping the
#   rafiq-no-sleep user unit active. No sudo or host package changes.
#   Container commands must use: perl -e 'alarm 900; exec @ARGV' docker --context default ...
#   A hung Docker step is CI-only, not run. No VM is needed for this check.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
work="$(mktemp -d "$root/packages/desktop/.cu-headless-XXXXXX")"
cleanup() {
  kill $(jobs -p) 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ -z "${JARVIS_CU_BIN:-}" ] && [ ! -d "$root/os/go/cmd/jarvis-cu" ]; then
  echo "os/go/cmd/jarvis-cu is missing: run this on a branch that has Plan U merged" >&2
  exit 2
fi
if [ -n "${JARVIS_CU_BIN:-}" ]; then
  helper="$JARVIS_CU_BIN"
else
  helper="$work/jarvis-cu"
  (cd "$root/os/go" && CGO_ENABLED=0 go build -o "$helper" ./cmd/jarvis-cu)
fi

export XDG_RUNTIME_DIR="$work/run"
mkdir -m 0700 -p "$XDG_RUNTIME_DIR"
export WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1
mkdir -p "$work/labwc"
printf '<?xml version="1.0"?>\n<labwc_config/>\n' > "$work/labwc/rc.xml"
labwc -C "$work/labwc" &

WAYLAND_DISPLAY=""
for _ in $(seq 1 100); do
  for candidate in "$XDG_RUNTIME_DIR"/wayland-*; do
    if [ -S "$candidate" ]; then
      WAYLAND_DISPLAY="${candidate##*/}"
      break
    fi
  done
  [ -n "$WAYLAND_DISPLAY" ] && break
  sleep 0.1
done
[ -n "$WAYLAND_DISPLAY" ] || { echo "labwc did not create its display socket" >&2; exit 1; }
export WAYLAND_DISPLAY
"$helper" &
for _ in $(seq 1 100); do
  [ -S "$XDG_RUNTIME_DIR/jarvis/cu.sock" ] && break
  sleep 0.1
done
[ -S "$XDG_RUNTIME_DIR/jarvis/cu.sock" ] || { echo "jarvis-cu did not create its socket" >&2; exit 1; }
GDK_BACKEND=wayland zenity --info --text "jarvis-cu test" &
sleep 2

cd "$root"
JARVIS_CU_LABWC=1 JARVIS_CU_BIN="$helper" \
  pnpm exec vitest run packages/desktop/src/daemon/os/cu-client.labwc.test.ts
