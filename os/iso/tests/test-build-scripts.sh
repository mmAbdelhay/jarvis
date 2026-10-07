#!/usr/bin/env bash
# bootloader-timeouts.sh, release-guard.sh, verify-chroot.sh, stub-debs.sh.
source "$(dirname "$0")/lib.sh"
scripts=$ISO_DIR/scripts
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

# --- bootloader timeouts (Review Focus 1) ---
src=$tmp/lb-bootloaders
mkdir -p "$src/isolinux" "$src/grub-pc" "$src/syslinux_common"
printf 'include menu.cfg\ndefault vesamenu.c32\nprompt 0\ntimeout 0\n' > "$src/isolinux/isolinux.cfg"
printf 'set default=0\n\nif true ; then\n  true\nfi\n' > "$src/grub-pc/config.cfg"
echo 'menu title Boot' > "$src/syslinux_common/menu.cfg"
work=$tmp/work; mkdir -p "$work/config"
LB_BOOTLOADERS_SRC=$src "$scripts/bootloader-timeouts.sh" "$work"
check "isolinux waits 5 s" grep -qx 'timeout 50' "$work/config/bootloaders/isolinux/isolinux.cfg"
check "isolinux no longer waits forever" bash -c "! grep -qx 'timeout 0' '$work/config/bootloaders/isolinux/isolinux.cfg'"
check "grub waits 5 s" grep -qx 'set timeout=5' "$work/config/bootloaders/grub-pc/config.cfg"
check "other templates copied untouched" test -f "$work/config/bootloaders/syslinux_common/menu.cfg"
rm -f "$src/isolinux/isolinux.cfg"
check "a changed template layout fails loudly" bash -c "! LB_BOOTLOADERS_SRC='$src' '$scripts/bootloader-timeouts.sh' '$tmp/work2' 2>/dev/null"

# --- release guard (Review Focus 3) ---
mkimage() { # mkimage DIR — a clean chroot + binary tree
  rm -rf "$1"
  mkdir -p "$1/chroot/usr/lib/jarvis/daemon" "$1/chroot/etc/environment.d" "$1/chroot/proc" \
    "$1/binary/boot/grub" "$1/binary/isolinux"
  echo 'const p = process.env.JARVIS_FAKE_PROVIDER;' > "$1/chroot/usr/lib/jarvis/daemon/main.js"
  echo "linux /live/vmlinuz $(cat "$ISO_DIR/bootappend")" > "$1/binary/boot/grub/grub.cfg"
  echo "append $(cat "$ISO_DIR/bootappend")" > "$1/binary/isolinux/live.cfg"
}
img=$tmp/img
mkimage "$img"
check "clean image passes (daemon may mention the variable)" "$scripts/release-guard.sh" "$img/chroot" "$img/binary"
echo 'JARVIS_FAKE_PROVIDER=/x.json' > "$img/chroot/etc/environment.d/90-x.conf"
check "fake provider in environment.d fails" bash -c "! '$scripts/release-guard.sh' '$img/chroot' '$img/binary' 2>/dev/null"
mkimage "$img"
mkdir -p "$img/chroot/usr/lib/systemd/user/jarvisd.service.d"
echo 'Environment=JARVIS_FAKE_PROVIDER=/x.json' > "$img/chroot/usr/lib/systemd/user/jarvisd.service.d/x.conf"
check "fake provider in a unit drop-in fails" bash -c "! '$scripts/release-guard.sh' '$img/chroot' '$img/binary' 2>/dev/null"
mkimage "$img"
sed -i 's/quiet/quiet systemd.debug_shell=ttyS0/' "$img/binary/boot/grub/grub.cfg"
check "debug shell in the boot menu fails" bash -c "! '$scripts/release-guard.sh' '$img/chroot' '$img/binary' 2>/dev/null"

# --- verify-chroot ---
mkchroot() { # mkchroot DIR — every piece of session wiring present
  local c=$1
  rm -rf "$c"
  mkdir -p "$c/etc/greetd" "$c/etc/xdg/labwc" "$c/etc/systemd/user/default.target.wants" \
    "$c/etc/systemd/system/multi-user.target.wants" "$c/var/lib/flatpak/repo" "$c/var/lib/flatpak/appstream/flathub" \
    "$c/var/lib/dpkg" "$c/usr/share/polkit-1/rules.d" "$c/usr/share/jarvis-shell/labwc"
  echo 'user = "jarvis"' > "$c/etc/greetd/config.toml"
  printf '<keybind key="Super_L" onRelease="yes"><action name="Execute" command="jarvis-shell --focus" />\n<keybind key="C-A-t">\n' > "$c/etc/xdg/labwc/rc.xml"
  echo '. /usr/share/jarvis-shell/labwc/autostart' > "$c/etc/xdg/labwc/autostart"
  echo '(while true; do jarvis-shell; sleep 1; done) &' > "$c/usr/share/jarvis-shell/labwc/autostart"
  echo 'polkit.addRule(function (action, subject) {});' > "$c/usr/share/polkit-1/rules.d/50-jarvis.rules"
  printf 'sudo:x:27:jarvis\njarvis-admins:x:990:\n' > "$c/etc/group"
  ln -s /usr/lib/systemd/user/jarvisd.service "$c/etc/systemd/user/default.target.wants/jarvisd.service"
  ln -s /usr/lib/systemd/system/greetd.service "$c/etc/systemd/system/display-manager.service"
  ln -s /usr/lib/systemd/system/graphical.target "$c/etc/systemd/system/default.target"
  ln -s /etc/systemd/system/jarvis-flathub-appstream.service \
    "$c/etc/systemd/system/multi-user.target.wants/jarvis-flathub-appstream.service"
  printf '[remote "flathub"]\nurl=https://dl.flathub.org/repo/\n' > "$c/var/lib/flatpak/repo/config"
  for p in jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper greetd labwc foot flatpak network-manager; do
    printf 'Package: %s\nStatus: install ok installed\n\n' "$p" >> "$c/var/lib/dpkg/status"
  done
}
mkchroot "$tmp/c"
check "complete chroot verifies" "$scripts/verify-chroot.sh" "$tmp/c"
rm "$tmp/c/etc/systemd/user/default.target.wants/jarvisd.service"
check "jarvisd not enabled is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
: > "$tmp/c/var/lib/flatpak/repo/config"
check "missing Flathub remote is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
rm "$tmp/c/usr/share/polkit-1/rules.d/50-jarvis.rules"
check "missing polkit rule is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
printf 'sudo:x:27:jarvis\n' > "$tmp/c/etc/group"
check "missing jarvis-admins group is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
rmdir "$tmp/c/var/lib/flatpak/appstream/flathub"
check "missing Flathub appstream only warns" "$scripts/verify-chroot.sh" "$tmp/c"
check "...and says so for the build log" grep -q '^JARVIS-BUILD-WARNING: image has no Flathub appstream' \
  <<<"$("$scripts/verify-chroot.sh" "$tmp/c" 2>&1)"
mkchroot "$tmp/c"
rm "$tmp/c/etc/systemd/system/multi-user.target.wants/jarvis-flathub-appstream.service"
check "first-boot appstream unit not enabled is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
sed -i '/Super_L/d' "$tmp/c/etc/xdg/labwc/rc.xml"
check "missing Super keybind is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"

# --- stub debs ---
if command -v dpkg-deb >/dev/null; then
  "$ISO_DIR/dev/stub-debs.sh" "$tmp/stubs" >/dev/null
  for p in jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper; do
    check "stub $p built" test -f "$tmp/stubs/${p}_0.0.0~stub1_amd64.deb"
  done
  check "stub jarvisd still enables its unit" grep -q 'systemctl --global enable' \
    <<<"$(dpkg-deb --ctrl-tarfile "$tmp/stubs/jarvisd_0.0.0~stub1_amd64.deb" | tar -xO ./postinst)"
  check "stub helper creates jarvis-admins" grep -q 'jarvis-admins' \
    <<<"$(dpkg-deb --ctrl-tarfile "$tmp/stubs/jarvis-helper_0.0.0~stub1_amd64.deb" | tar -xO ./postinst)"
else
  fail "stub debs: dpkg-deb missing (run through os/packaging/dev/trixie.sh)"
fi

finish
