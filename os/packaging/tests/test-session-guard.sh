#!/usr/bin/env bash
# The classic fallback trigger (M4 contracts §2), the session launcher and the
# Super-key dispatcher, with fake programs (Review Focus 2, 3). Runs anywhere.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
REPO_ROOT=$(cd "$PACKAGING_DIR/../.." && pwd)
# Arabic branding is shared by both desktop entries.
check "Arabic brand renders from the brand source" bash -c '
  source "$1/os/branding/lib/brand.sh"
  brand_load
  test "$(printf "%s" "@DISTRO_NAME_AR@" | brand_render_text)" = "رفيق"
' _ "$REPO_ROOT"
d=$PACKAGING_DIR/jarvis-session
guard=$d/jarvis-shell-guard key=$d/jarvis-session-key launcher=$d/jarvis-session
for f in "$guard" "$key" "$launcher"; do
  check "$(basename "$f") is POSIX sh" sh -n "$f"
  check "$(basename "$f") executable" test -x "$f"
done
to() { if command -v timeout >/dev/null; then timeout "$@"; else shift; "$@"; fi; }
xdg=$tmp/xdg; state=$xdg/jarvis
mkdir -p "$xdg"
printf '#!/bin/sh\necho "shell:$*" >> "%s/calls"\nexit "$(cat "%s/shell-rc")"\n' "$tmp" "$tmp" > "$tmp/shell"
printf '#!/bin/sh\necho "classic:$*" >> "%s/calls"\n' "$tmp" > "$tmp/classic"
printf '#!/bin/sh\nexit "$(cat "%s/jarvisd-state")"\n' "$tmp" > "$tmp/systemctl"   # 0 = is-failed
printf '#!/bin/sh\ncat "%s/now-value"\n' "$tmp" > "$tmp/now"
chmod +x "$tmp/shell" "$tmp/classic" "$tmp/systemctl" "$tmp/now"
echo 1 > "$tmp/jarvisd-state"
reset() { rm -rf "$state"; : > "$tmp/calls"; }
run_guard() { # run_guard NOW [MODE]
  echo "$1" > "$tmp/now-value"
  XDG_RUNTIME_DIR=$xdg JARVIS_SESSION_MODE=${2:-full} JARVIS_SHELL=$tmp/shell JARVIS_CLASSIC=$tmp/classic \
    JARVIS_NOW=$tmp/now JARVIS_SYSTEMCTL=$tmp/systemctl sh "$guard" || true
}

reset; echo 1 > "$tmp/shell-rc"
run_guard 100; run_guard 101
check "two crashes: still the full shell" test ! -e "$state/classic-fallback"
run_guard 103
check "the third crash within 60 s writes the fallback marker" grep -qx 'reason=shell-failed' "$state/classic-fallback"
check "the marker records when" grep -qx 'since=103' "$state/classic-fallback"
perm=$(stat -c %a "$state" 2>/dev/null || stat -f %Lp "$state")
check "the marker directory is private" test "$perm" = 700
run_guard 104
check "after the fallback the guard runs the classic desktop" test "$(tail -n1 "$tmp/calls")" = 'classic:'
check "the shell ran exactly three times" test "$(grep -c '^shell:' "$tmp/calls")" -eq 3

reset; echo 1 > "$tmp/shell-rc"
for t in 100 150 200 259; do run_guard "$t"; done
check "crashes spread over minutes never fall back" test ! -e "$state/classic-fallback"

reset; echo 0 > "$tmp/shell-rc"
for t in 100 101 102 103; do run_guard "$t"; done
check "clean exits never count" test ! -e "$state/classic-fallback"

reset; echo 0 > "$tmp/shell-rc"; echo 0 > "$tmp/jarvisd-state"
run_guard 100
check "jarvisd down: a running shell remains in full mode" test "$(cat "$tmp/calls")" = 'shell:'
check "jarvisd down alone never writes fallback" test ! -e "$state/classic-fallback"
echo 1 > "$tmp/jarvisd-state"

reset; run_guard 100 classic
check "classic session: the guard never starts jarvis-shell" test "$(cat "$tmp/calls")" = 'classic:'
check "choosing classic leaves no fallback marker" test ! -e "$state/classic-fallback"

loop=$REPO_ROOT/os/shell/data/jarvis-shell-loop
if [ -f "$loop" ]; then
  reset; echo 1 > "$tmp/shell-rc"
  : > "$xdg/wayland-test"
  printf '#!/bin/sh\necho "classic:$*" >> "%s/calls"\nrm -f "%s/wayland-test"\n' "$tmp" "$xdg" > "$tmp/classic-last"
  chmod +x "$tmp/classic-last"
  XDG_RUNTIME_DIR=$xdg WAYLAND_DISPLAY=wayland-test JARVIS_SHELL_BIN=$guard JARVIS_LOOP_SLEEP=true \
    JARVIS_SHELL=$tmp/shell JARVIS_CLASSIC=$tmp/classic-last JARVIS_SYSTEMCTL=$tmp/systemctl \
    to 20 sh "$loop" || true
  check "jarvis-shell-loop + guard: three crashes, then the classic desktop" \
    test "$(paste -sd, "$tmp/calls")" = 'shell:,shell:,shell:,classic:'
else
  echo "SKIP: os/shell/data/jarvis-shell-loop not present" >&2
fi

key_run() { XDG_RUNTIME_DIR=$xdg JARVIS_SHELL=$tmp/shell JARVIS_CLASSIC=$tmp/classic "$@"; }
reset; echo 0 > "$tmp/shell-rc"
key_run env JARVIS_SESSION_MODE=full sh "$key" --focus
check "full session: Super goes to jarvis-shell --focus" test "$(cat "$tmp/calls")" = 'shell:--focus'
reset; key_run env JARVIS_SESSION_MODE=classic sh "$key" --voice
check "classic session: Super+Space opens the docked chat" test "$(cat "$tmp/calls")" = 'classic:--chat'
reset; mkdir -p "$state"; echo reason=shell-failed > "$state/classic-fallback"
key_run env JARVIS_SESSION_MODE=full sh "$key" --focus
check "after a fallback: Super opens the docked chat, never a new full shell" test "$(cat "$tmp/calls")" = 'classic:--chat'

printf '#!/bin/sh\necho "labwc:$JARVIS_SESSION_MODE:$*" >> "%s/calls"\n' "$tmp" > "$tmp/labwc"
chmod +x "$tmp/labwc"
reset; mkdir -p "$state"; echo reason=shell-failed > "$state/classic-fallback"; echo 100 > "$state/shell-failures"
XDG_RUNTIME_DIR=$xdg JARVIS_LABWC=$tmp/labwc sh "$launcher" classic
check "the launcher exports the mode and starts labwc" test "$(cat "$tmp/calls")" = 'labwc:classic:-C /etc/xdg/labwc-classic'
check "a marker from an earlier login is cleared" test ! -e "$state/classic-fallback"
check "old failure times are cleared" test ! -e "$state/shell-failures"
reset; XDG_RUNTIME_DIR=$xdg JARVIS_LABWC=$tmp/labwc sh "$launcher"
check "no argument means the full session" test "$(cat "$tmp/calls")" = 'labwc:full:'
check "an unknown mode is refused" bash -c "! XDG_RUNTIME_DIR='$xdg' JARVIS_LABWC='$tmp/labwc' sh '$launcher' kiosk 2>/dev/null"
finish
