#!/usr/bin/env bash
# bootloader-config.sh, release-guard.sh, verify-chroot.sh, stub-debs.sh.
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/m3-fixture.sh"
source "$(dirname "$0")/m4-fixture.sh"
source "$(dirname "$0")/v11-fixture.sh"
scripts=$ISO_DIR/scripts
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

# --- bootloader config: 5 s, our theme, UEFI templates only ---
src=$tmp/lb-bootloaders
mkdir -p "$src/grub-pc/live-theme" "$src/isolinux"
printf 'set default=0\n\nif true ; then\n  true\nfi\n' > "$src/grub-pc/config.cfg"
printf 'if loadfont $prefix/unicode.pf2 ; then\n  set theme=/boot/grub/live-theme/theme.txt\nfi\n' > "$src/grub-pc/theme.cfg"
echo stock > "$src/grub-pc/live-theme/theme.txt"; echo png > "$src/grub-pc/splash.png"
brand=$tmp/brand/usr/share/grub/themes/jarvis; mkdir -p "$brand"
printf 'title-text: ""\n+ label { text = "Rafiq" }\n' > "$brand/theme.txt"; echo bg > "$brand/background.png"; echo f > "$brand/plex-16.pf2"
work=$tmp/work; mkdir -p "$work/config"
LB_BOOTLOADERS_SRC=$src "$scripts/bootloader-config.sh" "$work" "$tmp/brand"
g=$work/config/bootloaders/grub-pc
check "grub waits 5 s" grep -qx 'set timeout=5' "$g/config.cfg"
check "our theme replaces live-build's" cmp -s "$brand/theme.txt" "$g/live-theme/theme.txt"
check "theme fonts copied" test -f "$g/live-theme/plex-16.pf2"
check "splash is our background" cmp -s "$brand/background.png" "$g/splash.png"
check "isolinux templates not copied (UEFI only)" test ! -e "$work/config/bootloaders/isolinux"
printf 'set theme=/boot/grub/other/theme.txt\n' > "$src/grub-pc/theme.cfg"
check "a changed template layout fails loudly" bash -c "! LB_BOOTLOADERS_SRC='$src' '$scripts/bootloader-config.sh' '$tmp/w2' '$tmp/brand' 2>/dev/null"
check "missing branding fails loudly" bash -c "! LB_BOOTLOADERS_SRC='$src' '$scripts/bootloader-config.sh' '$tmp/w3' '$tmp/nobrand' 2>/dev/null"
check "old timeouts script removed" test ! -e "$scripts/bootloader-timeouts.sh"

# --- release guard (Review Focus 3) ---
mkimage() { # mkimage DIR — a clean chroot + binary tree
  rm -rf "$1"
  mkdir -p "$1/chroot/usr/lib/jarvis/daemon" "$1/chroot/etc/environment.d" "$1/chroot/proc" \
    "$1/binary/boot/grub"
  echo 'const p = process.env.JARVIS_FAKE_PROVIDER;' > "$1/chroot/usr/lib/jarvis/daemon/main.js"
  echo "linux /live/vmlinuz $(cat "$ISO_DIR/bootappend")" > "$1/binary/boot/grub/grub.cfg"
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

# --- release keyring guard (Review Focus 4) ---
if command -v gpg >/dev/null; then
  mkimage "$img"
  kg=$tmp/kg; fpr=$("$REPO_ROOT/os/repo/test-key.sh" "$kg")
  mkdir -p "$img/chroot/usr/share/keyrings"
  gpg --homedir "$kg" --export "$fpr" > "$img/chroot/usr/share/keyrings/jarvis-archive-keyring.gpg"
  mkdir -p "$tmp/keys"; echo "$fpr" > "$tmp/keys/FINGERPRINT"
  check "non-release build allows a throwaway keyring" "$scripts/release-guard.sh" "$img/chroot" "$img/binary"
  check "release refuses a NOT FOR RELEASE key" bash -c "! '$scripts/release-guard.sh' '$img/chroot' '$img/binary' --release '$tmp/keys' 2>/dev/null"
  echo 0000000000000000000000000000000000000000 > "$tmp/keys/FINGERPRINT"
  check "release refuses a fingerprint mismatch" bash -c "! '$scripts/release-guard.sh' '$img/chroot' '$img/binary' --release '$tmp/keys' 2>/dev/null"
  rm -f "$tmp/keys/FINGERPRINT"
  check "release refuses when no FINGERPRINT is committed" bash -c "! '$scripts/release-guard.sh' '$img/chroot' '$img/binary' --release '$tmp/keys' 2>/dev/null"
else
  fail "release keyring guard: gpg missing (run through os/packaging/dev/trixie.sh with TRIXIE_PACKAGES="gpg gpg-agent")"
fi

# --- check-iso on a non-bootable ISO lists every problem ---
if command -v xorriso >/dev/null; then
  mkdir -p "$tmp/isotree/EFI"; echo x > "$tmp/isotree/EFI/readme"
  xorriso -as mkisofs -quiet -V WRONG -o "$tmp/bad.iso" "$tmp/isotree" 2>/dev/null
  out=$("$scripts/check-iso.sh" "$tmp/bad.iso" 2>&1 || true)
  check "check-iso: no UEFI entry reported" grep -q 'no UEFI El Torito entry' <<<"$out"
  check "check-iso: volume id reported" grep -q "volume id 'WRONG'" <<<"$out"
  check "check-iso: unsigned shim reported" grep -q 'bootx64.efi' <<<"$out"
fi

# --- verify-chroot ---
VERIFY_PKGS="jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper jarvis-ui jarvis-greeter jarvis-installer jarvis-installer-backend jarvis-model-fetch jarvis-ollama jarvis-models-catalog jarvis-archive-keyring jarvis-branding greetd cage labwc foot flatpak network-manager plymouth cryptsetup-initramfs grub-efi-amd64-signed shim-signed mokutil os-prober"
# lsinitramfs cannot chroot into a fixture: the checker takes an override.
fakelsinit=$tmp/fake-lsinitramfs
printf '#!/bin/sh\necho usr/share/plymouth/themes/jarvis/jarvis.script\necho usr/sbin/cryptsetup\n' > "$fakelsinit"; chmod +x "$fakelsinit"
export VERIFY_LSINITRAMFS=$fakelsinit
mkchroot() { # mkchroot DIR — every piece of session wiring present
  local c=$1
  rm -rf "$c"
  mkdir -p "$c/etc/greetd" "$c/etc/xdg/labwc" "$c/etc/systemd/user/default.target.wants" \
    "$c/etc/systemd/system/multi-user.target.wants" "$c/var/lib/flatpak/repo" "$c/var/lib/flatpak/appstream/flathub" \
    "$c/var/lib/dpkg" "$c/usr/share/polkit-1/rules.d" "$c/usr/share/jarvis-shell/labwc"
  printf '[terminal]\nvt = 1\n[default_session]\ncommand = "/usr/lib/jarvis-greeter/with-keyboard cage -s -- jarvis-greeter"\nuser = "_greetd"\n' > "$c/etc/greetd/config.toml"
  mkdir -p "$c/usr/lib/live/config" "$c/etc/plymouth" "$c/boot" "$c/usr/share/keyrings" "$c/etc/apt/sources.list.d" \
    "$c/usr/share/jarvis/models" "$c/usr/lib/systemd/system" "$c/etc/pam.d" "$c/usr/share/grub/themes/jarvis"
  printf '#!/bin/sh\n' > "$c/usr/lib/live/config/2000-jarvis-live-session"; chmod 0755 "$c/usr/lib/live/config/2000-jarvis-live-session"
  printf 'NAME="Rafiq"\nID=rafiq\nID_LIKE=debian\nPRETTY_NAME="Rafiq 0.2 (trixie)"\n' > "$c/usr/lib/os-release"
  ln -s ../usr/lib/os-release "$c/etc/os-release"
  echo 'Theme=jarvis' > "$c/etc/plymouth/plymouthd.conf"
  : > "$c/boot/initrd.img-6.12.0-amd64"
  printf 'Types: deb\nURIs: https://mmabdelhay.github.io/jarvis-apt\nEnabled: no\n' > "$c/etc/apt/sources.list.d/jarvis.sources"
  touch "$c/usr/share/keyrings/jarvis-archive-keyring.gpg" \
    "$c/usr/share/jarvis/models/catalog.json" "$c/usr/share/grub/themes/jarvis/theme.txt"
  ln -s /usr/lib/systemd/system/ollama.service "$c/etc/systemd/system/multi-user.target.wants/ollama.service"
  echo 'ConditionKernelCommandLine=!boot=live' > "$c/usr/lib/systemd/system/ollama.service"
  echo 'auth optional pam_gnome_keyring.so' > "$c/etc/pam.d/greetd"
  printf '<keybind key="Super_L" onRelease="yes"><action name="Execute" command="/usr/libexec/jarvis/jarvis-session-key --focus" />\n<keybind key="C-A-t">\n' > "$c/etc/xdg/labwc/rc.xml"
  echo '. /usr/share/jarvis-session/labwc/autostart' > "$c/etc/xdg/labwc/autostart"
  echo '(while true; do jarvis-shell; sleep 1; done) &' > "$c/usr/share/jarvis-shell/jarvis-shell-loop"
  echo 'polkit.addRule(function (action, subject) {});' > "$c/usr/share/polkit-1/rules.d/50-jarvis.rules"
  printf 'sudo:x:27:jarvis\njarvis-admins:x:990:\n' > "$c/etc/group"
  ln -s /usr/lib/systemd/user/jarvisd.service "$c/etc/systemd/user/default.target.wants/jarvisd.service"
  ln -s /usr/lib/systemd/system/greetd.service "$c/etc/systemd/system/display-manager.service"
  ln -s /usr/lib/systemd/system/graphical.target "$c/etc/systemd/system/default.target"
  ln -s /etc/systemd/system/jarvis-flathub-appstream.service \
    "$c/etc/systemd/system/multi-user.target.wants/jarvis-flathub-appstream.service"
  printf '[remote "flathub"]\nurl=https://dl.flathub.org/repo/\n' > "$c/var/lib/flatpak/repo/config"
  for p in $VERIFY_PKGS; do
    case $p in
      # As in Debian's status file: Protected comes before Status.
      grub-efi-amd64-signed) printf 'Package: %s\nProtected: yes\nStatus: install ok installed\n\n' "$p" ;;
      *) printf 'Package: %s\nStatus: install ok installed\n\n' "$p" ;;
    esac >> "$c/var/lib/dpkg/status"
  done
  m3_fixture "$c"
  m4_fixture "$c"
  v11_fixture "$c"
}
mkchroot "$tmp/c"
check "complete chroot verifies" "$scripts/verify-chroot.sh" "$tmp/c"
printf '[initial_session]\nuser = "jarvis"\n' >> "$tmp/c/etc/greetd/config.toml"
check "an autologin in the image is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
sed -i 's/^ID=rafiq/ID=other/' "$tmp/c/usr/lib/os-release"
check "wrong os-release ID is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
# live-build's bootstrap leaves a copy of Debian's os-release in /etc.
rm "$tmp/c/etc/os-release"
printf 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nIMAGE_ID=live\n' > "$tmp/c/etc/os-release"
check "live-build's stale /etc/os-release copy is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
sed -i '/^Package: grub-efi-amd64-signed$/,/^$/d' "$tmp/c/var/lib/dpkg/status"
check "missing grub-efi-amd64-signed is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
rm "$tmp/c/usr/lib/live/config/2000-jarvis-live-session"
check "missing live-config script is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
sed -i '/^ConditionKernel/d' "$tmp/c/usr/lib/systemd/system/ollama.service"
check "ollama running in the live session is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
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
sed -i '/Super_L/,/<\/keybind>/d' "$tmp/c/etc/xdg/labwc/rc.xml"   # the whole bind: the real rc.xml spans lines
check "missing Super keybind is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
sed -i '/^Enabled:/d' "$tmp/c/etc/apt/sources.list.d/jarvis.sources"
check "jarvis.sources without an Enabled field is caught" bash -c "! '$scripts/verify-chroot.sh' '$tmp/c' 2>/dev/null"
mkchroot "$tmp/c"
sed -i 's/^Enabled: no$/Enabled: yes/' "$tmp/c/etc/apt/sources.list.d/jarvis.sources"
check "an enabled jarvis.sources verifies" "$scripts/verify-chroot.sh" "$tmp/c"

# --- stub debs ---
if command -v dpkg-deb >/dev/null; then
  "$ISO_DIR/dev/stub-debs.sh" "$tmp/stubs" >/dev/null
  for p in jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper jarvis-ui jarvis-installer jarvis-greeter \
    jarvis-installer-backend jarvis-model-fetch; do
    check "stub $p built" test -f "$tmp/stubs/${p}_0.0.0~stub1_amd64.deb"
  done
  dpkg-deb -x "$tmp/stubs/jarvis-shell_0.0.0~stub1_amd64.deb" "$tmp/shell-stub"
  shell_loop=$tmp/shell-stub/usr/share/jarvis-shell/jarvis-shell-loop
  check "stub shell ships an executable relaunch loop" test -x "$shell_loop"
  check "stub loop honours JARVIS_SHELL_BIN, relaunches and stops with labwc" python3 - "$shell_loop" "$tmp" <<'PY'
import os
from pathlib import Path
import subprocess
import sys

loop, tmp = sys.argv[1:]
runtime = Path(tmp) / "stub-runtime"
runtime.mkdir()
socket = runtime / "wayland-test"
socket.touch()
calls = runtime / "calls"
shell = runtime / "fake shell"
shell.write_text('#!/bin/sh\necho launch >> "$XDG_RUNTIME_DIR/calls"\n'
                 'if [ "$(wc -l < "$XDG_RUNTIME_DIR/calls")" -eq 2 ]; then\n'
                 '  rm "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"\nfi\nexit 1\n')
shell.chmod(0o755)
env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime), WAYLAND_DISPLAY="wayland-test",
           JARVIS_SHELL_BIN=str(shell))
subprocess.run([loop], env=env, check=True, timeout=5)
assert calls.read_text().splitlines() == ["launch", "launch"]
# With the compositor gone, another invocation must not launch the shell.
subprocess.run([loop], env=env, check=True, timeout=5)
assert calls.read_text().splitlines() == ["launch", "launch"]
PY
  mkchroot "$tmp/c"
  rm "$tmp/c/usr/share/jarvis-shell/jarvis-shell-loop"
  cp -R "$tmp/shell-stub/usr/share/jarvis-shell/." "$tmp/c/usr/share/jarvis-shell/"
  check "chroot with the packaged stub shell loop verifies" "$scripts/verify-chroot.sh" "$tmp/c"
  check "stub greeter ships the real greetd config" grep -q 'cage -s -- jarvis-greeter' \
    <<<"$(dpkg-deb --fsys-tarfile "$tmp/stubs/jarvis-greeter_0.0.0~stub1_amd64.deb" | tar -xO ./etc/greetd/config.toml)"
  check "stub greeter ships the keyboard wrapper its config runs" bash -c 'dpkg-deb -c "$1" | grep -q "^-rwxr-xr-x .* ./usr/lib/jarvis-greeter/with-keyboard$"' _ "$tmp/stubs/jarvis-greeter_0.0.0~stub1_amd64.deb"
  check "stub greeter keeps the real diversion" grep -q 'dpkg-divert' \
    <<<"$(dpkg-deb --ctrl-tarfile "$tmp/stubs/jarvis-greeter_0.0.0~stub1_amd64.deb" | tar -xO ./preinst)"
  check "stub jarvisd still enables its unit" grep -q 'systemctl --global enable' \
    <<<"$(dpkg-deb --ctrl-tarfile "$tmp/stubs/jarvisd_0.0.0~stub1_amd64.deb" | tar -xO ./postinst)"
  check "stub helper creates jarvis-admins" grep -q 'jarvis-admins' \
    <<<"$(dpkg-deb --ctrl-tarfile "$tmp/stubs/jarvis-helper_0.0.0~stub1_amd64.deb" | tar -xO ./postinst)"
else
  fail "stub debs: dpkg-deb missing (run through os/packaging/dev/trixie.sh)"
fi

finish
