#!/usr/bin/env bash
# jarvis-fonts (M4 contracts §3). The fc-match checks need the fonts installed
# and root in a throwaway container: JARVIS_DPKG_INSTALL_TESTS=1 and
# TRIXIE_PACKAGES="fontconfig fonts-inter fonts-ibm-plex fonts-noto-core".
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-fonts >/dev/null
deb=$tmp/out/jarvis-fonts_${OS_VERSION}_all.deb
check "fontconfig rule shipped" deb_has "$deb" usr/share/fontconfig/conf.avail/65-jarvis-arabic.conf
check "enabled through /etc/fonts/conf.d" \
  grep -qF './etc/fonts/conf.d/65-jarvis-arabic.conf -> ../../../usr/share/fontconfig/conf.avail/65-jarvis-arabic.conf' <<<"$(deb_list "$deb")"
check "the conf.d link is not a conffile" bash -c "! dpkg-deb --ctrl-tarfile '$deb' | tar -xO ./conffiles 2>/dev/null | grep -qxF /etc/fonts/conf.d/65-jarvis-arabic.conf"
deps=$(deb_field "$deb" Depends)
for p in fontconfig fonts-inter fonts-ibm-plex fonts-noto-core; do check "Depends has $p" grep -qw -- "$p" <<<"$deps"; done
check "rule is well-formed XML" python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' \
  "$PACKAGING_DIR/jarvis-fonts/65-jarvis-arabic.conf"
if [ "${JARVIS_DPKG_INSTALL_TESTS:-0}" = 1 ] && [ "$(id -u)" = 0 ] && command -v fc-match >/dev/null; then
  dpkg -i "$deb" >/dev/null
  fc-cache -f >/dev/null
  fam() { fc-match -f '%{family[0]}' "$1"; }
  sans=$(fam 'sans-serif:lang=ar'); echo "Arabic sans-serif: $sans"
  check "Arabic sans is IBM Plex Sans Arabic or Noto Sans Arabic" grep -Eqx 'IBM Plex Sans Arabic|Noto Sans Arabic' <<<"$sans"
  inter=$(fam 'Inter:charset=627'); echo "Arabic letters in Inter: $inter"
  check "Arabic letters in an Inter UI fall back to that Arabic face" test "$inter" = "$sans"
  check "Arabic serif is Noto Naskh Arabic" test "$(fam 'serif:lang=ar')" = 'Noto Naskh Arabic'
  check "Latin UI text stays Inter" test "$(fam 'Inter')" = Inter
  ar=$(fc-list ':lang=ar' family)
  check "Noto Kufi Arabic installed" grep -q 'Noto Kufi Arabic' <<<"$ar"
  check "Noto Naskh Arabic installed" grep -q 'Noto Naskh Arabic' <<<"$ar"
else
  echo "SKIP fc-match checks (JARVIS_DPKG_INSTALL_TESTS=1 as root with the font packages)" >&2
fi
finish
