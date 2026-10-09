# shellcheck shell=bash
# v11_fixture CHROOT — the v1.1 pieces verify-v11.sh expects, built from the
# real files of this tree (so the verifier and the shipped config cannot drift).
v11_fixture() {
  local c=$1 p inc=$ISO_DIR/config/includes.chroot_after_packages/etc/xdg
  mkdir -p "$c/var/lib/dpkg" "$c/usr/libexec/jarvis" "$c/usr/lib/systemd/user" "$c/usr/share/jarvis-cu/labwc" \
    "$c/etc/xdg/labwc" "$c/etc/xdg/labwc-classic" "$c/usr/share/dbus-1/services" "$c/usr/share/jarvis/models"
  for p in jarvis-cu at-spi2-core; do
    printf 'Package: %s\nStatus: install ok installed\nVersion: 0.5.0~test\n\n' "$p" >> "$c/var/lib/dpkg/status"
  done
  install -m0755 /dev/null "$c/usr/libexec/jarvis/jarvis-cu"
  cp "$REPO_ROOT/os/packaging/jarvis-cu/jarvis-cu.service" "$c/usr/lib/systemd/user/"
  cp "$REPO_ROOT/os/packaging/jarvis-cu/labwc-autostart" "$c/usr/share/jarvis-cu/labwc/autostart"
  cp "$inc/labwc/autostart" "$inc/labwc/environment" "$inc/labwc/rc.xml" "$c/etc/xdg/labwc/"
  install -m0755 "$REPO_ROOT/os/packaging/jarvis-session/jarvis-session-key" "$c/usr/libexec/jarvis/"
  cp "$inc/labwc-classic/autostart" "$c/etc/xdg/labwc-classic/"
  install -m0755 "$REPO_ROOT/os/packaging/jarvis-session/jarvis-shell-guard" "$c/usr/libexec/jarvis/"
  : > "$c/usr/share/dbus-1/services/org.a11y.Bus.service"
  cp "$REPO_ROOT/os/models/catalog.json" "$c/usr/share/jarvis/models/catalog.json"
}
