#!/usr/bin/env bash
# GRUB theme, defaults and the dual-boot timeout script.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
"$BRANDING_DIR/render.sh" "$tmp/root" >/dev/null
g=$tmp/root/usr/share/grub/themes/jarvis
for f in theme.txt background.png plex-16.pf2 plex-24.pf2; do check "theme has $f" test -f "$g/$f"; done
check "pf2 font names match theme.txt (16)" grep -qa 'IBM Plex Sans Regular 16' "$g/plex-16.pf2"
check "pf2 font names match theme.txt (24)" grep -qa 'IBM Plex Sans Regular 24' "$g/plex-24.pf2"
check "theme uses the fonts" bash -c "grep -q '\"IBM Plex Sans Regular 16\"' '$g/theme.txt' && grep -q '\"IBM Plex Sans Regular 24\"' '$g/theme.txt'"
check "theme title is the brand" grep -q 'text = "Rafiq"' "$g/theme.txt"
d=$tmp/root/etc/default/grub.d/jarvis.cfg
check "defaults: distributor" grep -qx 'GRUB_DISTRIBUTOR="Rafiq"' "$d"
check "defaults: theme" grep -qx 'GRUB_THEME=/usr/share/grub/themes/jarvis/theme.txt' "$d"
check "defaults: splash" grep -qx 'GRUB_CMDLINE_LINUX_DEFAULT="quiet splash"' "$d"
check "defaults: hidden menu" bash -c "grep -qx 'GRUB_TIMEOUT_STYLE=hidden' '$d' && grep -qx 'GRUB_TIMEOUT=0' '$d'"
check "defaults: os-prober on" grep -qx 'GRUB_DISABLE_OS_PROBER=false' "$d"
check "defaults parse as sh" sh -n "$d"
s=$tmp/root/etc/grub.d/42_jarvis_timeout
check "timeout script executable" test -x "$s"
mkdir -p "$tmp/bin"
printf '#!/bin/sh\necho "/dev/vda1@/efi/Microsoft/Boot/bootmgfw.efi:Windows Boot Manager:Windows:efi"\n' > "$tmp/bin/os-prober"
chmod +x "$tmp/bin/os-prober"
check "another OS -> 3 s menu" test "$(PATH=$tmp/bin:$PATH "$s")" = "$(printf 'set timeout_style=menu\nset timeout=3')"
printf '#!/bin/sh\nexit 0\n' > "$tmp/bin/os-prober"
check "alone -> nothing (hidden)" test -z "$(PATH=$tmp/bin:$PATH "$s")"
printf '#!/bin/sh\necho x\n' > "$tmp/bin/os-prober"
check "GRUB_DISABLE_OS_PROBER=true -> nothing" test -z "$(GRUB_DISABLE_OS_PROBER=true PATH=$tmp/bin:$PATH "$s")"
rm "$tmp/bin/os-prober"
check "no os-prober -> nothing, exit 0" bash -c "out=\$(PATH='$tmp/bin':/usr/bin:/bin '$s') && [ -z \"\$out\" ]"
finish
