#!/usr/bin/env bash
# inspect-windows-disk.sh IMAGE — after an "alongside" install (root):
#   ntfsfix=ok|fail   ntfsfix --no-action on the Windows partition (criterion 3)
#   bootmgfw=yes|no   the Windows Boot Manager is still on the ESP
set -euo pipefail
img=$1
loop=$(losetup -rfP --show "$img")
mnt=$(mktemp -d)
cleanup() { umount "$mnt" 2>/dev/null || true; rmdir "$mnt"; losetup -d "$loop"; }
trap cleanup EXIT
udevadm settle 2>/dev/null || true
ntfs=$(lsblk -nrpo NAME,FSTYPE "$loop" | awk '$2 == "ntfs" {print $1; exit}')
if [ -n "$ntfs" ] && ntfsfix --no-action "$ntfs" >/dev/null 2>&1; then echo ntfsfix=ok; else echo ntfsfix=fail; fi
esp=$(lsblk -nrpo NAME,PARTTYPE "$loop" | awk 'tolower($2) == "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" {print $1; exit}')
if [ -n "$esp" ] && mount -o ro "$esp" "$mnt" && [ -f "$mnt/EFI/Microsoft/Boot/bootmgfw.efi" ]; then
  echo bootmgfw=yes
else
  echo bootmgfw=no
fi
