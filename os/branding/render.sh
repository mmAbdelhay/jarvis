#!/usr/bin/env bash
# render.sh OUT_ROOT — render every branding asset into OUT_ROOT at its install
# path (jarvis-branding's stage.sh, ISO GRUB menu). Needs rsvg-convert
# (librsvg2-bin), grub-mkfont (grub-common) and fonts-ibm-plex.
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

# Tasks 3-5 append their sections below this line.
echo "render: $out"
