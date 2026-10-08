#!/usr/bin/env bash
# bootloader-config.sh WORK BRANDING_ROOT — live-build's own GRUB templates
# (the UEFI menu; there is no BIOS menu) into WORK/config/bootloaders with a
# 5 s timeout (upstream sets none, so a real boot would wait forever) and our
# GRUB theme from the jarvis-branding tree as the menu theme and splash.
set -euo pipefail
work=$1 branding=$2
src=${LB_BOOTLOADERS_SRC:-/usr/share/live/build/bootloaders}
theme=$branding/usr/share/grub/themes/jarvis
dest=$work/config/bootloaders
die() { echo "bootloader-config: $*" >&2; exit 1; }
[ -f "$src/grub-pc/config.cfg" ] && [ -f "$src/grub-pc/theme.cfg" ] || die "live-build grub-pc templates not under $src"
[ -f "$theme/theme.txt" ] && [ -f "$theme/background.png" ] || die "no GRUB theme at $theme (jarvis-branding)"
grep -q 'live-theme/theme.txt' "$src/grub-pc/theme.cfg" ||
  die "live-build's grub-pc/theme.cfg no longer loads live-theme/theme.txt; update this script"
mkdir -p "$dest"
rm -rf "$dest/grub-pc"
cp -a "$src/grub-pc" "$dest/"
g=$dest/grub-pc
if grep -q '^set timeout=' "$g/config.cfg"; then
  sed -i -E 's/^set timeout=.*/set timeout=5/' "$g/config.cfg"
else
  sed -i '/^set default=/a set timeout=5' "$g/config.cfg"
fi
grep -qx 'set timeout=5' "$g/config.cfg"
rm -rf "$g/live-theme"
mkdir -p "$g/live-theme"
cp -a "$theme/." "$g/live-theme/"
cp "$theme/background.png" "$g/splash.png"
