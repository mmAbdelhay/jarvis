#!/usr/bin/env bash
# jarvis-session package layout (M4 contracts §2).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-session >/dev/null
deb=$tmp/out/jarvis-session_${OS_VERSION}_all.deb
x() { dpkg-deb --fsys-tarfile "$deb" | tar -xO "./$1"; }
for f in usr/share/wayland-sessions/rafiq.desktop usr/share/wayland-sessions/rafiq-classic.desktop; do
  check "/$f (contracts §2)" deb_has "$deb" "$f"
done
for f in jarvis-session jarvis-shell-guard jarvis-session-key; do
  check "$f 0755" test "$(deb_mode "$deb" "usr/libexec/jarvis/$f")" = -rwxr-xr-x
done
check "autostart fragment 0644" test "$(deb_mode "$deb" usr/share/jarvis-session/labwc/autostart)" = -rw-r--r--
full=$(x usr/share/wayland-sessions/rafiq.desktop)
classic=$(x usr/share/wayland-sessions/rafiq-classic.desktop)
check "default session runs the full mode" grep -qx 'Exec=/usr/libexec/jarvis/jarvis-session full' <<<"$full"
check "classic session runs the classic mode" grep -qx 'Exec=/usr/libexec/jarvis/jarvis-session classic' <<<"$classic"
check "brand rendered (full)" grep -qx 'Name=Rafiq' <<<"$full"
check "brand rendered (classic)" grep -qx 'Name=Rafiq (classic)' <<<"$classic"
check "no placeholder left" bash -c '! grep -q @ <<<"$1"' _ "$full$classic"
check "Arabic name and comment in both" python3 - "$full" "$classic" <<'PY'
import re, sys
for t in sys.argv[1:]:
    assert re.search(r"^Comment\[ar\]=.*[؀-ۿ]", t, re.M), t
    assert re.search(r"^Name\[ar\]=رفيق(?: \(الوضع الكلاسيكي\))?$", t, re.M), t
PY
check "DesktopNames=labwc;wlroots (full)" grep -qx 'DesktopNames=labwc;wlroots' <<<"$full"
check "DesktopNames=labwc;wlroots (classic)" grep -qx 'DesktopNames=labwc;wlroots' <<<"$classic"
if command -v desktop-file-validate >/dev/null; then
  # DesktopNames is the display-manager session key (labwc.desktop has it too); it is
  # outside the Desktop Entry spec, so desktop-file-validate rejects it. Validate the rest.
  grep -vx 'DesktopNames=labwc;wlroots' <<<"$full" > "$tmp/full.desktop"
  grep -vx 'DesktopNames=labwc;wlroots' <<<"$classic" > "$tmp/classic.desktop"
  check "desktop-file-validate (full)" desktop-file-validate "$tmp/full.desktop"
  check "desktop-file-validate (classic)" desktop-file-validate "$tmp/classic.desktop"
fi
check "the fragment runs jarvis-shell-loop through the guard" \
  grep -Fxq 'JARVIS_SHELL_BIN=/usr/libexec/jarvis/jarvis-shell-guard /usr/share/jarvis-shell/jarvis-shell-loop &' \
  <<<"$(x usr/share/jarvis-session/labwc/autostart)"
check "Depends: labwc" grep -qw labwc <<<"$(deb_field "$deb" Depends)"
# Exercise the packaged launcher with a fake compositor (no Wayland session).
x usr/libexec/jarvis/jarvis-session > "$tmp/launcher"
printf '#!/bin/sh\nprintf "%%s\\n" "$JARVIS_SESSION_MODE" "$@"\n' > "$tmp/labwc"
chmod +x "$tmp/labwc"
mkdir -p "$tmp/runtime"
args=$(XDG_RUNTIME_DIR=$tmp/runtime JARVIS_LABWC=$tmp/labwc sh "$tmp/launcher" classic)
check "classic launcher selects its config directory" test "$args" = "$(printf 'classic\n-C\n/etc/xdg/labwc-classic')"
finish
