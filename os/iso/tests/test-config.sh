#!/usr/bin/env bash
# The live-build tree: options, boot line, package lists, hooks.
source "$(dirname "$0")/lib.sh"

auto=$ISO_DIR/auto/config
append=$(cat "$ISO_DIR/bootappend")
lists=("$ISO_DIR"/config/package-lists/*.list.chroot)
all_packages=$(grep -hv '^\s*#' "${lists[@]}" | awk 'NF {print $1}')

check "auto/config parses" sh -n "$auto"
check "auto/build parses" sh -n "$ISO_DIR/auto/build"
check "auto/clean parses" sh -n "$ISO_DIR/auto/clean"
check "trixie" grep -q -- '--distribution trixie' "$auto"
check "amd64" grep -q -- '--architectures amd64' "$auto"
check "archive areas" grep -q -- '--archive-areas "main contrib non-free-firmware"' "$auto"
check "ISO disk image" grep -q -- '--binary-images iso-hybrid' "$auto"
check "apt indices kept (pkg.install needs them)" grep -q -- '--apt-indices true' "$auto"

check "bootappend is one line" test "$(wc -l < "$ISO_DIR/bootappend")" -eq 1
for token in boot=live components username=jarvis hostname=jarvis; do
  check "bootappend has $token" grep -qw -- "$token" <<<"$append"
done
check "live user groups (contracts §4)" grep -Eq 'user-default-groups=([a-z-]+,)*systemd-journal' <<<"$append"
for group in systemd-journal netdev sudo jarvis-admins; do
  check "group $group" grep -Eq "user-default-groups=[^ ]*\\b$group\\b" <<<"$append"
done
for forbidden in debug_shell console=ttyS JARVIS_; do
  check "bootappend free of $forbidden" bash -c "! grep -q -- '$forbidden' <<<'$append'"
done

check "package names are valid" bash -c "! grep -Evx '[a-z0-9][a-z0-9+.-]+' <<<'$all_packages'"
check "no package listed twice" test -z "$(sort <<<"$all_packages" | uniq -d)"
# design §9 plus contracts §6 #20.
for p in greetd labwc foot layer-shell-qt qt6-wayland pipewire polkitd gnome-keyring network-manager \
  network-manager-config-connectivity-debian pciutils usbutils flatpak sudo live-boot \
  live-config user-setup libsecret-tools iputils-ping rfkill iproute2 fonts-inter dbus-daemon \
  jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper; do
  check "lists include $p" grep -qx "$p" <<<"$all_packages"
done

for hook in "$ISO_DIR"/config/hooks/normal/*.hook.chroot; do
  check "$(basename "$hook") parses" sh -n "$hook"
  check "$(basename "$hook") executable" test -x "$hook"
done
check "flathub hook verifies the remote" grep -q 'flatpak remotes' "$ISO_DIR/config/hooks/normal/0100-flathub.hook.chroot"
check "flathub hook fetches appstream (§6 #20)" grep -q 'flatpak update --system --appstream flathub' "$ISO_DIR/config/hooks/normal/0100-flathub.hook.chroot"
check "flathub hook enables the first-boot fetch" grep -q 'systemctl enable jarvis-flathub-appstream.service' "$ISO_DIR/config/hooks/normal/0100-flathub.hook.chroot"
# live-build refuses both (E: You have files in includes.chroot and
# includes.chroot_after_packages); hooks run after the latter anyway.
check "no legacy includes.chroot beside includes.chroot_after_packages" test ! -e "$ISO_DIR/config/includes.chroot"
check "first-boot appstream unit" python3 - "$ISO_DIR/config/includes.chroot_after_packages/etc/systemd/system/jarvis-flathub-appstream.service" <<'PY'
import configparser, sys
u = configparser.ConfigParser(strict=False, interpolation=None)
u.optionxform = str
u.read(sys.argv[1])
assert u["Service"]["Type"] == "oneshot", u["Service"]["Type"]
assert u["Service"]["ExecStart"] == "/usr/bin/flatpak update --system --appstream flathub"
assert u["Service"]["Restart"] == "on-failure"
assert "network-online.target" in u["Unit"]["After"] and "network-online.target" in u["Unit"]["Wants"]
assert u["Unit"]["ConditionPathExists"] == "!/var/lib/flatpak/appstream/flathub/x86_64/active"
assert u["Unit"]["StartLimitIntervalSec"] == "0"
assert u["Install"]["WantedBy"] == "multi-user.target"
PY
check "session hook requires jarvis-admins" grep -q 'jarvis-admins' "$ISO_DIR/config/hooks/normal/0200-session.hook.chroot"

# --- M2: UEFI only, Secure Boot, brand (design §2, §7, §11; contracts §9) ---
check "UEFI only: grub-efi is the only bootloader" grep -q -- '--bootloaders grub-efi \\' "$auto"
check "no syslinux/isolinux" bash -c "! grep -q syslinux '$auto'"
check "secure boot via shim" grep -q -- '--uefi-secure-boot enable' "$auto"
check "volume from the brand" grep -Fq -- '--iso-volume "$ISO_VOLUME"' "$auto"
check "application from the brand" grep -Fq -- '--iso-application "$DISTRO_NAME"' "$auto"
check "auto/config sources brand.env" grep -qx '. ./brand.env' "$auto"
check "bootappend has splash (Plymouth)" grep -qw splash <<<"$append"
for p in plymouth cryptsetup cryptsetup-initramfs grub-efi-amd64 grub-efi-amd64-signed shim-signed efibootmgr \
  mokutil os-prober ntfs-3g gdisk dosfstools e2fsprogs squashfs-tools cage libpam-gnome-keyring \
  jarvis-ui jarvis-greeter jarvis-installer jarvis-installer-backend jarvis-model-fetch jarvis-ollama \
  jarvis-models-catalog jarvis-archive-keyring jarvis-branding; do
  check "lists include $p" grep -qx "$p" <<<"$all_packages"
done
check "no grub-pc (BIOS) anywhere" bash -c "! grep -qx 'grub-pc' <<<\"\$1\"" _ "$all_packages"
hook=$ISO_DIR/config/hooks/normal/0300-boot.hook.chroot
check "boot hook rebuilds the initramfs" grep -q 'update-initramfs -u -k all' "$hook"
check "boot hook requires the jarvis Plymouth theme" grep -q 'plymouth-set-default-theme' "$hook"
check "boot hook wires gnome-keyring into greetd PAM" grep -q 'pam_gnome_keyring.so auto_start' "$hook"
check "boot hook refuses an autologin in the image" grep -q 'initial_session' "$hook"

check "daily APT lists refresh" grep -Fxq 'APT::Periodic::Update-Package-Lists "1";' "$ISO_DIR/config/includes.chroot_after_packages/etc/apt/apt.conf.d/20jarvis-periodic"

finish
