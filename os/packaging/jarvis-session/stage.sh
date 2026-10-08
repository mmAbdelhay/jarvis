#!/usr/bin/env bash
# Stage jarvis-session (M4 contracts §2): the two Wayland session entries,
# the launcher, the classic-fallback guard, the Super-key dispatcher and the
# labwc autostart fragment.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
stage=$1
# shellcheck source=../../branding/lib/brand.sh
. "$REPO_ROOT/os/branding/lib/brand.sh"
brand_load
sessions=$stage/usr/share/wayland-sessions
mkdir -p "$sessions"
brand_render "$here/session.desktop.in" "$sessions/$DISTRO_ID.desktop"
brand_render "$here/classic.desktop.in" "$sessions/$DISTRO_ID-classic.desktop"
chmod 0644 "$sessions"/*.desktop
for f in jarvis-session jarvis-shell-guard jarvis-session-key; do
  install -D -m0755 "$here/$f" "$stage/usr/libexec/jarvis/$f"
done
install -D -m0644 "$here/labwc-autostart" "$stage/usr/share/jarvis-session/labwc/autostart"
