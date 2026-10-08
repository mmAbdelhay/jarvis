#!/usr/bin/env bash
# check-iso.sh ISO — static checks on a built ISO (host side; needs xorriso
# and sbsigntool): size, UEFI only, Microsoft-signed shim + Debian-signed GRUB
# (Secure Boot, design §7), brand volume id and menu theme, the boot line,
# 5 s timeout, nothing that enables a debug shell.
set -euo pipefail
iso=$1
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../../branding/lib/brand.sh
. "$here/../../branding/lib/brand.sh"
brand_load
max_mb=${ISO_MAX_MB:-1900}
append=$(cat "$here/../bootappend")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
problems=()

size_mb=$(($(stat -c %s "$iso") / 1024 / 1024))
[ "$size_mb" -le "$max_mb" ] || problems+=("ISO is $size_mb MB, over the $max_mb MB ceiling")

report=$(xorriso -indev "$iso" -report_el_torito plain 2>/dev/null || true)
grep -Eq 'El Torito boot img : +[0-9]+ +UEFI' <<<"$report" || problems+=("no UEFI El Torito entry")
grep -Eq 'El Torito boot img : +[0-9]+ +BIOS' <<<"$report" && problems+=("BIOS El Torito entry present (UEFI only)")
vol=$(xorriso -indev "$iso" -pvd_info 2>/dev/null | sed -n 's/^Volume Id *: *//p')
[ "$vol" = "$ISO_VOLUME" ] || problems+=("volume id '$vol' is not the brand's '$ISO_VOLUME'")

for f in /boot/grub/grub.cfg /boot/grub/config.cfg /boot/grub/live-theme/theme.txt /EFI/boot/bootx64.efi /EFI/boot/grubx64.efi; do
  xorriso -osirrox on -indev "$iso" -extract "$f" "$tmp/$(basename "$f")" >/dev/null 2>&1 || problems+=("$f missing from the ISO")
done
if [ -f "$tmp/bootx64.efi" ]; then
  sbverify --list "$tmp/bootx64.efi" 2>/dev/null | grep -Eq 'Microsoft.*UEFI CA' ||
    problems+=("EFI/boot/bootx64.efi is not shim signed by the Microsoft UEFI CA")
else
  problems+=("EFI/boot/bootx64.efi (shim) missing")
fi
if [ -f "$tmp/grubx64.efi" ]; then
  sbverify --list "$tmp/grubx64.efi" 2>/dev/null | grep -q 'Debian Secure Boot' ||
    problems+=("EFI/boot/grubx64.efi is not Debian-signed GRUB")
fi
grep -qF "text = \"$DISTRO_NAME\"" "$tmp/theme.txt" 2>/dev/null || problems+=("ISO menu theme does not carry the brand")
grep -qF -- "$append" "$tmp/grub.cfg" 2>/dev/null || problems+=("GRUB entry lacks os/iso/bootappend")
grep -qx 'set timeout=5' "$tmp/config.cfg" 2>/dev/null || problems+=("GRUB timeout is not 5 s")
if grep -qE 'debug_shell|JARVIS_' "$tmp"/*.cfg 2>/dev/null; then
  problems+=("a boot menu enables a debug shell or a JARVIS_ switch")
fi
if [ ${#problems[@]} -gt 0 ]; then
  printf 'check-iso: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "check-iso: ok ($size_mb MB, $vol)"
