#!/usr/bin/env bash
# v1.1 session wiring (contracts §1): jarvis-cu starts from the full session's
# autostart after the environment import and never from the classic one;
# toolkits put their widgets on the AT-SPI bus for password-field detection.
source "$(dirname "$0")/lib.sh"
inc=$ISO_DIR/config/includes.chroot_after_packages/etc/xdg
a=$inc/labwc/autostart
line='if [ -r /usr/share/jarvis-cu/labwc/autostart ]; then . /usr/share/jarvis-cu/labwc/autostart; fi'
check "autostart is POSIX sh" sh -n "$a"
check "autostart starts jarvis-cu through its fragment" grep -qxF "$line" "$a"
n_import=$(grep -n 'systemctl --user import-environment' "$a" | head -n1 | cut -d: -f1)
n_cu=$(grep -nF "$line" "$a" | head -n1 | cut -d: -f1)
n_shell=$(grep -n 'jarvis-session/labwc/autostart' "$a" | head -n1 | cut -d: -f1)
check "after WAYLAND_DISPLAY reaches the user manager" test "${n_import:-0}" -lt "${n_cu:-0}"
check "before the shell starts" test "${n_cu:-0}" -lt "${n_shell:-0}"
check "classic autostart never starts computer use" bash -c '! grep -q jarvis-cu "$1"' _ "$inc/labwc-classic/autostart"
for v in GNOME_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1; do
  check "environment: $v" grep -qx "$v" "$inc/labwc/environment"
done
finish
