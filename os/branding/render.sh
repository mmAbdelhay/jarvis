#!/usr/bin/env bash
# render.sh OUT_ROOT — render every branding asset into OUT_ROOT at its install
# path (jarvis-branding's stage.sh, ISO GRUB menu). Needs rsvg-convert
# (librsvg2-bin), grub-mkfont (grub-common) and a font (PLEX_FONT, else fonts-inter).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/brand.sh
. "$here/lib/brand.sh"
brand_load
out=$1
mkdir -p "$out"
need() { command -v "$1" >/dev/null || { echo "render: $1 not found (install $2)" >&2; exit 1; }; }
need rsvg-convert librsvg2-bin
svg2png() { rsvg-convert --width "$2" --height "$3" --keep-aspect-ratio "$1" -o "$4"; }

# Logo and icons.
install -D -m0644 "$here/logo/jarvis-ring.svg" "$out/usr/share/pixmaps/jarvis.svg"
install -D -m0644 "$here/logo/jarvis-ring.svg" "$out/usr/share/icons/hicolor/scalable/apps/jarvis.svg"
for s in 16 24 32 48 64 128 256 512; do
  mkdir -p "$out/usr/share/icons/hicolor/${s}x${s}/apps"
  svg2png "$here/logo/jarvis-ring.svg" "$s" "$s" "$out/usr/share/icons/hicolor/${s}x${s}/apps/jarvis.png"
done
brand_render "$here/logo/wordmark.svg.in" "$out/usr/share/pixmaps/jarvis-wordmark.svg"
chmod 0644 "$out/usr/share/pixmaps/jarvis-wordmark.svg"

# Wallpaper (greeter background; GRUB uses the 1080p one).
bg=$out/usr/share/backgrounds/jarvis
install -D -m0644 "$here/wallpaper/wallpaper.svg" "$bg/wallpaper.svg"
svg2png "$here/wallpaper/wallpaper.svg" 3840 2160 "$bg/wallpaper-3840x2160.png"
svg2png "$here/wallpaper/wallpaper.svg" 1920 1080 "$bg/wallpaper-1920x1080.png"

# Plymouth theme "jarvis" (Task 3).
pt=$out/usr/share/plymouth/themes/jarvis
mkdir -p "$pt"
brand_render "$here/plymouth/jarvis.plymouth.in" "$pt/jarvis.plymouth"
brand_render "$here/plymouth/jarvis.script.in" "$pt/jarvis.script"
svg2png "$here/logo/jarvis-ring.svg" 160 160 "$pt/logo.png"
rsvg-convert "$here/plymouth/entry.svg" -o "$pt/entry.png"
rsvg-convert "$here/plymouth/bullet.svg" -o "$pt/bullet.png"
chmod 0644 "$pt"/*

# GRUB theme and defaults (Task 4).
need grub-mkfont grub-common
# Debian has no IBM Plex package: use PLEX_FONT, an installed Plex, else Inter
# (fonts-inter). The internal font names below are ids the theme references.
plex=${PLEX_FONT:-}
if [ -z "$plex" ]; then
  for c in /usr/share/fonts/opentype/ibm-plex/IBMPlexSans-Regular.otf /usr/share/fonts/opentype/inter/Inter-Regular.otf; do
    if [ -f "$c" ]; then plex=$c; break; fi
  done
fi
[ -f "$plex" ] || { echo "render: no font found (set PLEX_FONT or install fonts-inter)" >&2; exit 1; }
gt=$out/usr/share/grub/themes/jarvis
mkdir -p "$gt"
brand_render "$here/grub/theme.txt.in" "$gt/theme.txt"
cp "$bg/wallpaper-1920x1080.png" "$gt/background.png"
grub-mkfont -s 16 -n "IBM Plex Sans Regular 16" -o "$gt/plex-16.pf2" "$plex"
grub-mkfont -s 24 -n "IBM Plex Sans Regular 24" -o "$gt/plex-24.pf2" "$plex"
chmod 0644 "$gt"/*
mkdir -p "$out/etc/default/grub.d" "$out/etc/grub.d"
brand_render "$here/grub/jarvis.cfg.in" "$out/etc/default/grub.d/jarvis.cfg"
chmod 0644 "$out/etc/default/grub.d/jarvis.cfg"
install -m0755 "$here/grub/42_jarvis_timeout" "$out/etc/grub.d/42_jarvis_timeout"

# The localized distro name for UI text (M4 contracts §6.8): Jarvis.UI's
# Brand.distroName reads it, falling back to os-release NAME.
mkdir -p "$out/usr/share/jarvis"
brand_render "$here/brand.json.in" "$out/usr/share/jarvis/brand.json"
chmod 0644 "$out/usr/share/jarvis/brand.json"

# os-release (Task 5). /etc/os-release is base-files' symlink to this file.
mkdir -p "$out/usr/lib"
brand_render "$here/os-release.in" "$out/usr/lib/os-release"
chmod 0644 "$out/usr/lib/os-release"

echo "render: $out"
