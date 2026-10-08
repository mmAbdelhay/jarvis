#!/usr/bin/env bash
# make-windows-disk.sh IMAGE SIZE_GIB clean|hibernated|bitlocker|dirty — a raw disk
# that looks like a Windows install to os-prober and ntfsresize (design §13).
# Root: losetup, sgdisk, mkfs.vfat, mkntfs, ntfs-3g.
set -euo pipefail
img=$1 size=$2 state=$3
case $state in clean|hibernated|bitlocker|dirty) ;; *) echo "make-windows-disk: unknown state $state" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "make-windows-disk: run as root" >&2; exit 1; }
rm -f "$img"
truncate -s "${size}G" "$img"
sgdisk -Z -n1:2048:+300M -t1:ef00 -c1:"EFI system partition" \
  -n2:0:+16M -t2:0c01 -c2:"Microsoft reserved partition" \
  -n3:0:0 -t3:0700 -c3:"Basic data partition" "$img" >/dev/null
loop=$(losetup -fP --show "$img")
mnt=$(mktemp -d)
cleanup() { umount "$mnt" 2>/dev/null || true; rmdir "$mnt"; losetup -d "$loop"; }
trap cleanup EXIT
udevadm settle 2>/dev/null || true
mkfs.vfat -F32 -n SYSTEM "${loop}p1" >/dev/null
mkntfs -Q -L Windows "${loop}p3" >/dev/null
mount "${loop}p1" "$mnt"
mkdir -p "$mnt/EFI/Microsoft/Boot"
printf 'MZ stand-in for the Windows Boot Manager\n' > "$mnt/EFI/Microsoft/Boot/bootmgfw.efi"
# os-prober lists "Windows Boot Manager" only when the BCD store sits next to it.
printf 'regf stand-in for the boot configuration data\n' > "$mnt/EFI/Microsoft/Boot/BCD"
umount "$mnt"
ntfs-3g "${loop}p3" "$mnt"
mkdir -p "$mnt/Windows/System32" "$mnt/Users/Test"
dd if=/dev/urandom of="$mnt/Users/Test/data.bin" bs=1M count=512 status=none
if [ "$state" = hibernated ]; then
  { printf 'HIBR'; head -c 1048572 /dev/zero; } > "$mnt/hiberfil.sys"
fi
umount "$mnt"
if [ "$state" = dirty ]; then
  # Windows shut down uncleanly / chkdsk scheduled (criterion 4: ntfs-dirty).
  python3 "$(dirname "$0")/ntfs-set-dirty.py" "${loop}p3"
fi
if [ "$state" = bitlocker ]; then
  printf -- '-FVE-FS-' | dd of="${loop}p3" bs=1 seek=3 conv=notrunc status=none
fi
sync
