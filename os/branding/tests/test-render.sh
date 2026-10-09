#!/usr/bin/env bash
# render.sh produces every asset at its install path, with the brand applied.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
png_size() { python3 -c 'import struct,sys; d=open(sys.argv[1],"rb").read(24); assert d[:8]==b"\x89PNG\r\n\x1a\n"; print("%dx%d" % struct.unpack(">II", d[16:24]))' "$1"; }

"$BRANDING_DIR/render.sh" "$tmp/root" >/dev/null
r=$tmp/root
check "logo svg" test -f "$r/usr/share/pixmaps/jarvis.svg"
check "scalable icon" test -f "$r/usr/share/icons/hicolor/scalable/apps/jarvis.svg"
for s in 16 24 32 48 64 128 256 512; do
  check "icon ${s}px" test "$(png_size "$r/usr/share/icons/hicolor/${s}x${s}/apps/jarvis.png")" = "${s}x${s}"
done
check "wordmark carries the brand name" grep -q '>Rafiq<' "$r/usr/share/pixmaps/jarvis-wordmark.svg"
check "wordmark has no placeholder" bash -c "! grep -q '@DISTRO' '$r/usr/share/pixmaps/jarvis-wordmark.svg'"
check "brand.json (M4 §6.8)" python3 -c 'import json,sys; d=json.load(open(sys.argv[1],encoding="utf-8")); assert d["name"]=={"en":"Rafiq","ar":"رفيق"}, d' "$r/usr/share/jarvis/brand.json"
check "initramfs keyboard hook (contracts §11.5)" test -x "$r/usr/share/initramfs-tools/hooks/jarvis-keyboard"
check "initramfs keyboard hook copies vconsole.conf and XKB data" bash -c "grep -q /etc/vconsole.conf '$r/usr/share/initramfs-tools/hooks/jarvis-keyboard' && grep -q /usr/share/X11/xkb '$r/usr/share/initramfs-tools/hooks/jarvis-keyboard'"
check "wallpaper 4k" test "$(png_size "$r/usr/share/backgrounds/jarvis/wallpaper-3840x2160.png")" = "3840x2160"
check "wallpaper 1080p" test "$(png_size "$r/usr/share/backgrounds/jarvis/wallpaper-1920x1080.png")" = "1920x1080"
check "logo is the ring (two circles, no text)" bash -c "[ \$(grep -c '<circle' '$BRANDING_DIR/logo/jarvis-ring.svg') -ge 2 ] && ! grep -q '<text' '$BRANDING_DIR/logo/jarvis-ring.svg'"
printf '%s\n' 'DISTRO_NAME="Nova Linux"' 'DISTRO_NAME_AR="نوفا"' 'DISTRO_ID="nova"' 'DISTRO_VERSION="1.0"' 'ISO_VOLUME="Nova"' 'HOME_URL="https://example.org"' > "$tmp/alt.env"
BRAND_ENV=$tmp/alt.env "$BRANDING_DIR/render.sh" "$tmp/alt" >/dev/null
check "another brand flows into brand.json" grep -q '"ar": "نوفا"' "$tmp/alt/usr/share/jarvis/brand.json"
check "another brand flows into the wordmark" grep -q '>Nova Linux<' "$tmp/alt/usr/share/pixmaps/jarvis-wordmark.svg"
check "render twice is identical (reproducible)" bash -c "'$BRANDING_DIR/render.sh' '$tmp/again' >/dev/null && diff -r '$r' '$tmp/again' >/dev/null"
finish
