#!/usr/bin/env bash
# The headless classic-fallback harness (Task 15) is wired to the real files.
# It runs in Linux CI only; this checks it statically anywhere.
source "$(dirname "$0")/lib.sh"
h=$ISO_DIR/session
check "classic.sh parses" bash -n "$h/classic.sh"
check "in-container-classic.sh parses" bash -n "$h/in-container-classic.sh"
check "classic.sh executable" test -x "$h/classic.sh"
check "unprivileged container" bash -c "! grep -q -- '--privileged' '$h/classic.sh'"
for f in etc/xdg/labwc/rc.xml etc/xdg/labwc/environment usr/local/bin/labwc etc/xdg/labwc/autostart; do
  check "uses the ISO's $f" grep -qF "\$inc/$f" "$h/in-container-classic.sh"
done
check "uses jarvis-shell's real relaunch loop" grep -qF '/src/os/shell/data/jarvis-shell-loop' "$h/in-container-classic.sh"
check "starts sessions through the real launcher" grep -qF '/usr/libexec/jarvis/jarvis-session' "$h/in-container-classic.sh"
check "headless pixman labwc" grep -q 'WLR_BACKENDS=headless' "$h/in-container-classic.sh"
for case in "the shell was tried exactly three times" "the classic desktop takes over" \
  "after the fallback, Super opens the docked chat" "classic session never starts jarvis-shell" \
  "a marker from the previous login is cleared" "Super reaches jarvis-shell --focus" "no fallback while the shell runs"; do
  check "covers: $case" grep -qF "\"$case\"" "$h/in-container-classic.sh"
done
finish
