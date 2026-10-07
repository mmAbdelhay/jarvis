#!/usr/bin/env bash
# check-iso.sh ISO — static checks on a built ISO (host side, needs xorriso):
# size, BIOS and UEFI boot entries, the boot menus carry os/iso/bootappend,
# a 5 s timeout, and nothing that enables a debug shell.
set -euo pipefail
iso=$1
here=$(cd "$(dirname "$0")" && pwd)
max_mb=${ISO_MAX_MB:-1600}
append=$(cat "$here/../bootappend")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
problems=()

size_mb=$(($(stat -c %s "$iso") / 1024 / 1024))
[ "$size_mb" -le "$max_mb" ] || problems+=("ISO is $size_mb MB, over the $max_mb MB ceiling")

report=$(xorriso -indev "$iso" -report_el_torito plain 2>/dev/null)
grep -Eq 'El Torito boot img : +[0-9]+ +BIOS' <<<"$report" || problems+=("no BIOS El Torito entry")
grep -Eq 'El Torito boot img : +[0-9]+ +UEFI' <<<"$report" || problems+=("no UEFI El Torito entry")

xorriso -osirrox on -indev "$iso" \
  -extract /boot/grub/grub.cfg "$tmp/grub.cfg" \
  -extract /boot/grub/config.cfg "$tmp/config.cfg" \
  -extract /isolinux/live.cfg "$tmp/live.cfg" \
  -extract /isolinux/isolinux.cfg "$tmp/isolinux.cfg" >/dev/null 2>&1 ||
  problems+=("boot menu files missing from the ISO")
grep -qF -- "$append" "$tmp/grub.cfg" 2>/dev/null || problems+=("GRUB entry lacks os/iso/bootappend")
grep -qF -- "$append" "$tmp/live.cfg" 2>/dev/null || problems+=("isolinux entry lacks os/iso/bootappend")
grep -qx 'timeout 50' "$tmp/isolinux.cfg" 2>/dev/null || problems+=("isolinux timeout is not 5 s")
grep -qx 'set timeout=5' "$tmp/config.cfg" 2>/dev/null || problems+=("GRUB timeout is not 5 s")
if grep -qE 'debug_shell|JARVIS_' "$tmp"/*.cfg 2>/dev/null; then
  problems+=("a boot menu enables a debug shell or a JARVIS_ switch")
fi

if [ ${#problems[@]} -gt 0 ]; then
  printf 'check-iso: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "check-iso: ok ($size_mb MB)"
