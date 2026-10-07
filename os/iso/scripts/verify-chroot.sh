#!/usr/bin/env bash
# verify-chroot.sh CHROOT — after lb build, check the image carries the
# session wiring the design requires (§9, contracts §4). Every problem is
# listed, then the script fails.
set -euo pipefail
c=$1
problems=()

grep -q 'user = "jarvis"' "$c/etc/greetd/config.toml" 2>/dev/null ||
  problems+=("greetd does not autologin user jarvis")
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
for p in jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper greetd labwc foot flatpak network-manager; do
  awk -v p="$p" '$0 == "Package: " p {getline; if ($0 == "Status: install ok installed") found = 1} END {exit !found}' \
    "$c/var/lib/dpkg/status" || problems+=("package $p is not installed")
done

if [ ${#problems[@]} -gt 0 ]; then
  printf 'verify-chroot: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "verify-chroot: ok"
