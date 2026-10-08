#!/usr/bin/env bash
# verify-chroot.sh CHROOT — after lb build, check the image carries the
# session wiring the design requires (§9, contracts §4). Every problem is
# listed, then the script fails.
set -euo pipefail
c=$1
# shellcheck source=../../branding/lib/brand.sh
. "$(dirname "$0")/../../branding/lib/brand.sh"
brand_load
problems=()

grep -q 'C-A-t' "$c/etc/xdg/labwc/rc.xml" 2>/dev/null ||
  problems+=("labwc rc.xml lacks the Ctrl+Alt+T terminal bind")
grep -q 'command="jarvis-shell --focus"' "$c/etc/xdg/labwc/rc.xml" 2>/dev/null ||
  problems+=("labwc rc.xml lacks the Super -> jarvis-shell --focus bind")
grep -qx '. /usr/share/jarvis-shell/labwc/autostart' "$c/etc/xdg/labwc/autostart" 2>/dev/null ||
  problems+=("labwc autostart does not source jarvis-shell's relaunch loop")
[ -f "$c/usr/share/jarvis-shell/labwc/autostart" ] ||
  problems+=("jarvis-shell's relaunch loop is not installed")
[ -f "$c/usr/share/polkit-1/rules.d/50-jarvis.rules" ] ||
  problems+=("polkit rule 50-jarvis.rules missing")
grep -q '^jarvis-admins:' "$c/etc/group" 2>/dev/null ||
  problems+=("group jarvis-admins missing")
[ -L "$c/etc/systemd/system/multi-user.target.wants/jarvis-flathub-appstream.service" ] ||
  problems+=("jarvis-flathub-appstream.service is not enabled")
if [ ! -d "$c/var/lib/flatpak/appstream/flathub" ]; then
  # Soft (coordinator decision on §6 #20): fetched on first boot instead.
  echo "JARVIS-BUILD-WARNING: image has no Flathub appstream; it will be fetched on first boot" >&2
fi
[ -L "$c/etc/systemd/user/default.target.wants/jarvisd.service" ] ||
  problems+=("jarvisd user unit is not enabled for every user")
case $(readlink "$c/etc/systemd/system/display-manager.service" 2>/dev/null) in
  */greetd.service) ;;
  *) problems+=("greetd is not the display manager") ;;
esac
case $(readlink "$c/etc/systemd/system/default.target" 2>/dev/null) in
  */graphical.target) ;;
  *) problems+=("default target is not graphical.target") ;;
esac
grep -q '^\[remote "flathub"\]' "$c/var/lib/flatpak/repo/config" 2>/dev/null ||
  problems+=("Flathub system remote missing")
for p in jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper jarvis-ui jarvis-greeter jarvis-installer \
  jarvis-installer-backend jarvis-model-fetch jarvis-ollama jarvis-models-catalog jarvis-archive-keyring jarvis-branding \
  greetd cage labwc foot flatpak network-manager plymouth cryptsetup-initramfs grub-efi-amd64-signed shim-signed mokutil os-prober; do
  awk -v p="$p" '$0 == "Package: " p {getline; if ($0 == "Status: install ok installed") found = 1} END {exit !found}' \
    "$c/var/lib/dpkg/status" || problems+=("package $p is not installed")
done

grep -q 'command = "/usr/lib/jarvis-greeter/with-keyboard cage -s -- jarvis-greeter"' "$c/etc/greetd/config.toml" 2>/dev/null ||
  problems+=("greetd does not run jarvis-greeter in cage (contracts §7)")
if grep -q '^\[initial_session\]' "$c/etc/greetd/config.toml" 2>/dev/null; then
  problems+=("the image autologins: an installed system would too (Review Focus 1)")
fi
[ -x "$c/usr/lib/live/config/2000-jarvis-live-session" ] ||
  problems+=("live-config script for the live autologin is missing")
grep -qx "ID=$DISTRO_ID" "$c/etc/os-release" 2>/dev/null || problems+=("os-release ID is not $DISTRO_ID")
grep -qx "PRETTY_NAME=\"$PRETTY_NAME\"" "$c/etc/os-release" 2>/dev/null || problems+=("os-release PRETTY_NAME is not $PRETTY_NAME")
grep -qx 'ID_LIKE=debian' "$c/etc/os-release" 2>/dev/null || problems+=("os-release lacks ID_LIKE=debian")
grep -qx 'Theme=jarvis' "$c/etc/plymouth/plymouthd.conf" 2>/dev/null || problems+=("Plymouth theme is not jarvis")
initrd=$(find "$c/boot" -maxdepth 1 -name 'initrd.img-*' | sort | tail -n1)
if [ -n "${VERIFY_LSINITRAMFS:-}" ]; then
  listing=$("$VERIFY_LSINITRAMFS" "$initrd" 2>/dev/null || true)
else
  listing=$(chroot "$c" lsinitramfs "/boot/$(basename "$initrd")" 2>/dev/null || true)
fi
grep -q 'usr/share/plymouth/themes/jarvis/jarvis.script' <<<"$listing" || problems+=("initramfs lacks the jarvis Plymouth theme")
grep -q 'cryptsetup' <<<"$listing" || problems+=("initramfs lacks cryptsetup")
[ -f "$c/usr/share/keyrings/jarvis-archive-keyring.gpg" ] || problems+=("archive keyring missing")
[ -f "$c/etc/apt/sources.list.d/jarvis.sources" ] || problems+=("APT source jarvis.sources missing")
[ -f "$c/usr/share/jarvis/models/catalog.json" ] || problems+=("model catalog missing")
[ -L "$c/etc/systemd/system/multi-user.target.wants/ollama.service" ] || problems+=("ollama.service not enabled")
grep -qx 'ConditionKernelCommandLine=!boot=live' "$c/usr/lib/systemd/system/ollama.service" 2>/dev/null ||
  problems+=("ollama would run in the live session")
grep -q pam_gnome_keyring "$c/etc/pam.d/greetd" 2>/dev/null || problems+=("greetd PAM does not unlock gnome-keyring")
[ -f "$c/usr/share/grub/themes/jarvis/theme.txt" ] || problems+=("GRUB theme missing")

if [ ${#problems[@]} -gt 0 ]; then
  printf 'verify-chroot: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "verify-chroot: ok"
