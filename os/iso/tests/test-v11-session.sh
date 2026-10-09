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
check "classic autostart stops computer use" grep -qxF 'systemctl --user stop jarvis-cu.service >/dev/null 2>&1 || true' "$inc/labwc-classic/autostart"
check "classic autostart never starts computer use" bash -c '! grep -v "^#" "$1" | grep jarvis-cu | grep -qv "systemctl --user stop jarvis-cu"' _ "$inc/labwc-classic/autostart"
check "classic stop comes after the environment import" bash -c '
  i=$(grep -n "systemctl --user import-environment" "$1" | head -n1 | cut -d: -f1)
  s=$(grep -n "systemctl --user stop jarvis-cu" "$1" | head -n1 | cut -d: -f1)
  test "${i:-0}" -gt 0 && test "${s:-0}" -gt "$i"' _ "$inc/labwc-classic/autostart"
for v in GNOME_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1; do
  check "environment: $v" grep -qx "$v" "$inc/labwc/environment"
done
finish
