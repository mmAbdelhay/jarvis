#!/usr/bin/env bash
# jarvis-branding: paths (contracts §7), os-release (design §11), scripts.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
if ! command -v rsvg-convert >/dev/null || ! command -v grub-mkfont >/dev/null; then
  echo "SKIP test-branding.sh (needs librsvg2-bin grub-common fonts-inter)"; exit 0
fi
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-branding >/dev/null
deb=$tmp/out/jarvis-branding_${OS_VERSION}_all.deb
for p in usr/share/plymouth/themes/jarvis/jarvis.plymouth usr/share/plymouth/themes/jarvis/jarvis.script \
  usr/share/grub/themes/jarvis/theme.txt usr/share/backgrounds/jarvis/wallpaper-3840x2160.png \
  usr/share/pixmaps/jarvis.svg usr/lib/os-release etc/default/grub.d/jarvis.cfg etc/grub.d/42_jarvis_timeout; do
  check "ships /$p" deb_has "$deb" "$p"
done
not_has() { ! deb_has "$@"; }
check "does not ship /etc/os-release (base-files symlink stays)" not_has "$deb" etc/os-release
osr=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/lib/os-release)
check "PRETTY_NAME" grep -qx 'PRETTY_NAME="Rafiq 0.2 (trixie)"' <<<"$osr"
check "ID" grep -qx 'ID=rafiq' <<<"$osr"
check "ID_LIKE" grep -qx 'ID_LIKE=debian' <<<"$osr"
check "NAME" grep -qx 'NAME="Rafiq"' <<<"$osr"
check "VERSION_CODENAME" grep -qx 'VERSION_CODENAME=trixie' <<<"$osr"
check "HOME_URL" grep -qx 'HOME_URL="https://github.com/mmAbdelhay/jarvis"' <<<"$osr"
check "arch all" test "$(deb_field "$deb" Architecture)" = all
check "description uses brand" grep -q 'Rafiq' <<<"$(deb_field "$deb" Description)"
check "depends on plymouth" grep -q 'plymouth' <<<"$(deb_field "$deb" Depends)"
check "preinst diverts os-release" grep -q 'dpkg-divert --package jarvis-branding --add --rename --divert /usr/lib/os-release.debian /usr/lib/os-release' <<<"$(deb_script "$deb" preinst)"
check "postrm restores os-release" grep -q 'dpkg-divert --package jarvis-branding --remove --rename' <<<"$(deb_script "$deb" postrm)"
check "postinst sets the plymouth theme" grep -q 'plymouth-set-default-theme jarvis' <<<"$(deb_script "$deb" postinst)"
check "conffiles: grub defaults" grep -qx '/etc/default/grub.d/jarvis.cfg' <<<"$(dpkg-deb --ctrl-tarfile "$deb" | tar -xO ./conffiles)"
for s in preinst postinst postrm; do check "$s is POSIX sh" sh -n "$PACKAGING_DIR/jarvis-branding/$s"; done

# Real install in a throwaway root: divert, install, remove, divert back.
if [ "$(id -u)" = 0 ] && [ -f /etc/debian_version ] && command -v dpkg >/dev/null; then
  cp /usr/lib/os-release "$tmp/orig"
  check "installs" bash -c "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq '$deb' >/dev/null 2>&1"
  check "os-release now branded" grep -qx 'ID=rafiq' /etc/os-release
  check "debian original kept aside" cmp -s "$tmp/orig" /usr/lib/os-release.debian
  check "removes" bash -c "dpkg -r jarvis-branding >/dev/null 2>&1"
  check "debian os-release restored" cmp -s "$tmp/orig" /usr/lib/os-release
fi
finish
