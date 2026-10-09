#!/usr/bin/env bash
# The headless classic-fallback harness (Task 15) is wired to the real files.
# It runs in Linux CI only; this checks it statically anywhere.
source "$(dirname "$0")/lib.sh"
h=$ISO_DIR/session
incdir=$ISO_DIR/config/includes.chroot_after_packages
check "classic.sh parses" bash -n "$h/classic.sh"
check "in-container-classic.sh parses" bash -n "$h/in-container-classic.sh"
check "classic.sh executable" test -x "$h/classic.sh"
check "unprivileged container" bash -c "! grep -q -- '--privileged' '$h/classic.sh'"
for f in etc/xdg/labwc/rc.xml etc/xdg/labwc/environment usr/local/bin/labwc etc/xdg/labwc/autostart; do
  check "uses the ISO's $f" grep -qF "\$inc/$f" "$h/in-container-classic.sh"
done
for f in rc.xml environment autostart; do
  check "uses the ISO's labwc-classic/$f" grep -qF "\$inc/etc/xdg/labwc-classic/$f" "$h/in-container-classic.sh"
done
check "does not build the classic config itself" bash -c "! grep -q 'os/classic/data' '$h/in-container-classic.sh'"
check "classic autostart is the ISO autostart with the classic line" bash -c '
  diff <(grep -v "^#" "$1/etc/xdg/labwc/autostart" | grep -v "jarvis-session/labwc/autostart") \
       <(grep -v "^#" "$1/etc/xdg/labwc-classic/autostart" | grep -v "jarvis-shell-loop &")' _ "$incdir"
check "classic autostart matches Plan R's classic line" bash -c '
  grep -qxF "$(grep -v "^#" "$1/os/classic/data/labwc/autostart")" "$2/etc/xdg/labwc-classic/autostart"' _ "$REPO_ROOT" "$incdir"
check "classic environment is the ISO environment" cmp -s "$incdir/etc/xdg/labwc/environment" "$incdir/etc/xdg/labwc-classic/environment"
check "classic rc.xml routes Super and Super+Space through jarvis-session-key" bash -c '
  f=$1/etc/xdg/labwc-classic/rc.xml; grep -q "jarvis-session-key --focus" "$f" && grep -q "jarvis-session-key --voice" "$f"' _ "$incdir"
check "uses jarvis-shell's real relaunch loop" grep -qF '/src/os/shell/data/jarvis-shell-loop' "$h/in-container-classic.sh"
check "starts sessions through the real launcher" grep -qF '/usr/libexec/jarvis/jarvis-session' "$h/in-container-classic.sh"
check "headless pixman labwc" grep -q 'WLR_BACKENDS=headless' "$h/in-container-classic.sh"
for case in "the shell was tried exactly three times" "the classic desktop takes over" \
  "after the fallback, Super opens the docked chat" "classic session never starts jarvis-shell" \
  "a marker from the previous login is cleared" "Super reaches jarvis-shell --focus" "no fallback while the shell runs"; do
  check "covers: $case" grep -qF "\"$case\"" "$h/in-container-classic.sh"
done
finish
