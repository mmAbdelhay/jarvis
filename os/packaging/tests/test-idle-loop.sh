#!/usr/bin/env bash
# jarvis-idle-loop and the labwc autostart fragment (Review Focus 2). Plain sh: runs anywhere.
source "$(dirname "$0")/lib.sh"
# macOS has no timeout(1): fall back to perl's alarm.
if ! command -v timeout >/dev/null; then timeout() { local t=$1; shift; perl -e 'alarm shift; exec @ARGV' "$t" "$@"; }; fi
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
loop=$PACKAGING_DIR/jarvis-idle/jarvis-idle-loop
frag=$PACKAGING_DIR/jarvis-idle/labwc-autostart
check "loop is POSIX sh" sh -n "$loop"
check "loop executable" test -x "$loop"
mkdir -p "$tmp/xdg"
printf '#!/bin/sh\necho "$1" >> "%s/sleeps"\n' "$tmp" > "$tmp/fake-sleep"; chmod +x "$tmp/fake-sleep"
crash_after() { # crash_after N — a jarvis-idle that exits at once; run N removes the socket
  printf '#!/bin/sh\necho run >> "%s/runs"\n[ "$(wc -l < "%s/runs")" -ge %s ] && rm -f "%s/xdg/wayland-test"\nexit 1\n' \
    "$tmp" "$tmp" "$1" "$tmp" > "$tmp/idle"
  chmod +x "$tmp/idle"
  rm -f "$tmp/runs" "$tmp/sleeps"
  : > "$tmp/xdg/wayland-test"
  XDG_RUNTIME_DIR=$tmp/xdg WAYLAND_DISPLAY=wayland-test JARVIS_IDLE_BIN=$tmp/idle \
    JARVIS_LOOP_SLEEP=$tmp/fake-sleep timeout 10 sh "$loop" || true
}
crash_after 3
check "restarts a crashed jarvis-idle until the compositor is gone" test "$(wc -l < "$tmp/runs")" -eq 3
check "back-off doubles" test "$(paste -sd' ' "$tmp/sleeps")" = "1 2"
crash_after 8
check "back-off is capped at 30 s" test "$(paste -sd' ' "$tmp/sleeps")" = "1 2 4 8 16 30 30"
rm -f "$tmp/runs" "$tmp/xdg/wayland-test"
XDG_RUNTIME_DIR=$tmp/xdg WAYLAND_DISPLAY=wayland-test JARVIS_IDLE_BIN=$tmp/idle timeout 5 sh "$loop" || true
check "no compositor, no idle daemon" test ! -e "$tmp/runs"

check "fragment is POSIX sh" sh -n "$frag"
check "fragment backgrounds the loop" grep -Fq '/usr/libexec/jarvis/jarvis-idle-loop &' "$frag"
# Run the fragment with the loop path swapped for a recorder.
sed "s#/usr/libexec/jarvis/jarvis-idle-loop#$tmp/rec#" "$frag" > "$tmp/frag"
printf '#!/bin/sh\necho started >> "%s/rec.log"\n' "$tmp" > "$tmp/rec"; chmod +x "$tmp/rec"
JARVIS_LIVE_MEDIUM=$tmp/no-such-dir sh "$tmp/frag"; sleep 1
check "installed systems start the idle lock" grep -qx started "$tmp/rec.log"
rm -f "$tmp/rec.log"; mkdir -p "$tmp/live"
JARVIS_LIVE_MEDIUM=$tmp/live sh "$tmp/frag"; sleep 1
check "live boots never idle-lock" test ! -e "$tmp/rec.log"
finish
