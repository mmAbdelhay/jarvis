#!/usr/bin/env bash
# Copy live-build's own bootloader templates into WORK/config/bootloaders and
# give both menus a 5 s timeout. Upstream ships isolinux with `timeout 0`
# (wait forever) and GRUB with no timeout at all, which would stop a real
# boot at the menu (success criterion 1). Copying instead of vendoring keeps
# us on whatever templates the installed live-build has.
set -euo pipefail
work=$1
src=${LB_BOOTLOADERS_SRC:-/usr/share/live/build/bootloaders}
dest=$work/config/bootloaders

if [ ! -f "$src/isolinux/isolinux.cfg" ] || [ ! -f "$src/grub-pc/config.cfg" ]; then
  echo "bootloader-timeouts: live-build templates not where expected under $src" >&2
  exit 1
fi
mkdir -p "$dest"
cp -a "$src/." "$dest/"

sed -i -E 's/^timeout[[:space:]]+[0-9]+$/timeout 50/' "$dest/isolinux/isolinux.cfg"
grep -qx 'timeout 50' "$dest/isolinux/isolinux.cfg" || echo 'timeout 50' >> "$dest/isolinux/isolinux.cfg"

if grep -q '^set timeout=' "$dest/grub-pc/config.cfg"; then
  sed -i -E 's/^set timeout=.*/set timeout=5/' "$dest/grub-pc/config.cfg"
else
  sed -i '/^set default=/a set timeout=5' "$dest/grub-pc/config.cfg"
fi
grep -qx 'set timeout=5' "$dest/grub-pc/config.cfg"
