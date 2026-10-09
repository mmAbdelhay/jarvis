#!/usr/bin/env bash
# The jarvis-workspace launcher itself (M4 contracts §6.16), run against a fake
# app: a private 0700 config dir, and no override that could point the app back
# at jarvisd's ~/.config/jarvis. Needs no dpkg.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
src=$PACKAGING_DIR/jarvis-workspace/jarvis-workspace
printf '#!/bin/sh\necho "$JARVIS_CONFIG_DIR"\n' > "$tmp/app"; chmod +x "$tmp/app"
sed "s|exec /opt/jarvis-workspace/jarvis|exec $tmp/app|" "$src" > "$tmp/wrap"
check "the fake app replaced the real exec line" grep -q "exec $tmp/app" "$tmp/wrap"
mkdir -p "$tmp/home"
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
out=$(env -i HOME="$tmp/home" PATH="$PATH" sh "$tmp/wrap")
check "JARVIS_CONFIG_DIR is ~/.config/jarvis-workspace" test "$out" = "$tmp/home/.config/jarvis-workspace"
check "config dir created 0700" test "$(mode "$tmp/home/.config/jarvis-workspace")" = 700
out=$(env -i HOME="$tmp/home" PATH="$PATH" JARVIS_WORKSPACE_CONFIG_DIR="$tmp/home/.config/jarvis" sh "$tmp/wrap")
check "no JARVIS_WORKSPACE_CONFIG_DIR override" test "$out" = "$tmp/home/.config/jarvis-workspace"
check "jarvisd's config dir untouched" test ! -e "$tmp/home/.config/jarvis"
out=$(env -i HOME="$tmp/home" PATH="$PATH" XDG_CONFIG_HOME="$tmp/xdg" sh "$tmp/wrap")
check "follows XDG_CONFIG_HOME" test "$out" = "$tmp/xdg/jarvis-workspace"
check "XDG config dir created 0700" test "$(mode "$tmp/xdg/jarvis-workspace")" = 700
check "the app keeps the caller's umask" bash -c '! grep -q "^umask" "$1"' _ "$src"
finish
