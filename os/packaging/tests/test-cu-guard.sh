#!/usr/bin/env bash
# The classic fallback stops computer use (v1.1 Review Focus 1): the classic
# desktop has no overlay to show or stop it. Runs anywhere (fake programs).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
guard=$PACKAGING_DIR/jarvis-session/jarvis-shell-guard
xdg=$tmp/xdg
mkdir -p "$xdg"
printf '#!/bin/sh\nexit 1\n' > "$tmp/shell"
printf '#!/bin/sh\necho classic >> "%s/calls"\n' "$tmp" > "$tmp/classic"
printf '#!/bin/sh\necho "$*" >> "%s/systemctl.calls"\n' "$tmp" > "$tmp/systemctl"
printf '#!/bin/sh\necho 100\n' > "$tmp/now"
chmod +x "$tmp/shell" "$tmp/classic" "$tmp/systemctl" "$tmp/now"
run() { # run [MODE]
  XDG_RUNTIME_DIR=$xdg JARVIS_SESSION_MODE=${1:-full} JARVIS_SHELL=$tmp/shell JARVIS_CLASSIC=$tmp/classic \
    JARVIS_NOW=$tmp/now JARVIS_SYSTEMCTL=$tmp/systemctl sh "$guard" || true
}
stops() { grep -qx -- '--user stop jarvis-cu.service' "$tmp/systemctl.calls"; }
check "guard is POSIX sh" sh -n "$guard"
: > "$tmp/systemctl.calls"; run; run
check "two crashes leave computer use alone" bash -c '! grep -q jarvis-cu "$1"' _ "$tmp/systemctl.calls"
run
check "the third crash stops jarvis-cu with the fallback" stops
: > "$tmp/systemctl.calls"; run
check "the relaunch with the fallback marker stops it again" stops
check "and only then starts the classic desktop" grep -qx classic "$tmp/calls"
rm -rf "$xdg/jarvis"; : > "$tmp/systemctl.calls"; run classic
check "the classic session stops it before jarvis-classic" stops
finish
