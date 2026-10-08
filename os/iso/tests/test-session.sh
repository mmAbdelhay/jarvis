#!/usr/bin/env bash
# greetd, labwc keybinds and autostart, and Plan C's relaunch loop.
source "$(dirname "$0")/lib.sh"
inc=$ISO_DIR/config/includes.chroot_after_packages
c_labwc=$REPO_ROOT/os/shell/data/labwc
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

inc_greetd=$inc/etc/greetd/config.toml
check "image ships no greetd config of its own (jarvis-greeter's is the installed one)" test ! -e "$inc_greetd"
live=$inc/usr/lib/live/config/2000-jarvis-live-session
check "live-config script executable" test -x "$live"
check "live-config script is POSIX sh" sh -n "$live"
mkdir -p "$tmp/live/etc/greetd"
check "live-config writes its test root" env LIVE_ROOT="$tmp/live" sh "$live"
check "live boots autologin jarvis into labwc" python3 - "$tmp/live/etc/greetd/config.toml" <<'PY'
import sys, tomllib
c = tomllib.load(open(sys.argv[1], "rb"))
assert c["initial_session"] == {"command": "labwc", "user": "jarvis"}, c
assert c["default_session"]["user"] == "_greetd", c
PY
check "keyring empty-password unlock only on live boots" grep -q 'if \[ -d /run/live/medium \]' "$inc/etc/xdg/labwc/autostart"
check "installer starts only where installed (live)" grep -Fxq 'if [ -x /usr/bin/jarvis-installer ]; then jarvis-installer & fi' "$inc/etc/xdg/labwc/autostart"

# keybinds FILE -> "key<TAB>action<TAB>command" lines, sorted
keybinds() {
  python3 - "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
kb = ET.parse(sys.argv[1]).getroot().find("keyboard")
assert kb.find("default") is not None, "missing <default/>: labwc would drop its stock binds"
rows = []
for b in kb.findall("keybind"):
    a = b.find("action")
    rows.append(f"{b.get('key')}\t{a.get('name')}\t{a.get('command')}")
print("\n".join(sorted(rows)))
PY
}
ours=$(keybinds "$inc/etc/xdg/labwc/rc.xml")
check "Super focuses the shell (§6 #14)" grep -Fxq $'Super_L\tExecute\tjarvis-shell --focus' <<<"$ours"
check "Ctrl+Alt+T opens foot" grep -Fxq $'C-A-t\tExecute\tfoot' <<<"$ours"
check "Super acts on release (so Super+key chords still work)" python3 - "$inc/etc/xdg/labwc/rc.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
kb = ET.parse(sys.argv[1]).getroot().find("keyboard")
assert [b for b in kb.findall("keybind") if b.get("key") == "Super_L"][0].get("onRelease") == "yes"
PY
check "Super+L runs jarvis-lock directly (including live boots without jarvis-idle)" grep -Fxq $'W-l\tExecute\tjarvis-lock' <<<"$ours"
check "Super+Space is push-to-talk" grep -Fxq $'W-space\tExecute\tjarvis-shell --voice' <<<"$ours"
check "no key is bound twice" test -z "$(cut -f1 <<<"$ours" | sort | uniq -d)"
auto=$inc/etc/xdg/labwc/autostart
check "autostart hands the session to the user manager" \
  grep -Fxq 'systemctl --user import-environment WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP >/dev/null 2>&1 || true' "$auto"
check "autostart updates D-Bus activation env too" \
  grep -Fxq 'dbus-update-activation-environment --systemd WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP >/dev/null 2>&1 || true' "$auto"
check "autostart starts mako" grep -qx 'mako &' "$auto"
check "autostart starts the idle lock" grep -Fxq '. /usr/share/jarvis-idle/labwc/autostart' "$auto"
check "env imports, idle lock, then the shell" python3 - "$auto" <<'PYORDER'
import sys
t = open(sys.argv[1]).read()
a = t.index("import-environment WAYLAND_DISPLAY")
d = t.index("dbus-update-activation-environment --systemd")
b = t.index(". /usr/share/jarvis-idle/labwc/autostart")
c = t.index(". /usr/share/jarvis-shell/labwc/autostart")
assert a < d < b < c, (a, d, b, c)
PYORDER
if [ -f "$c_labwc/rc.xml" ]; then
  # Shell binds are a subset; the session also supplies the lock chord.
  check "every jarvis-shell bind is ours, same action" \
    test -z "$(comm -23 <(keybinds "$c_labwc/rc.xml") <(printf '%s\n' "$ours"))"
else
  echo "SKIP: Plan C's os/shell/data/labwc/rc.xml not landed yet" >&2
fi

check "autostart parses" sh -n "$inc/etc/xdg/labwc/autostart"
check "autostart sources C's relaunch loop" grep -qx '. /usr/share/jarvis-shell/labwc/autostart' "$inc/etc/xdg/labwc/autostart"
check "environment is KEY=VALUE lines" bash -c "! grep -Ev '^(#.*|[A-Z_]+=.*)$|^$' '$inc/etc/xdg/labwc/environment'"
check "Qt uses Wayland" grep -qx 'QT_QPA_PLATFORM=wayland' "$inc/etc/xdg/labwc/environment"
# labwc applies this file with setenv(..., 1) after the /usr/local/bin/labwc
# wrapper exported /etc/default/keyboard (contracts §11.5): any XKB line here
# would silently force that layout on every installed system.
check "environment leaves the keyboard to /etc/default/keyboard" bash -c "! grep -q '^XKB_' '$inc/etc/xdg/labwc/environment'"

# Review Focus 2: C's loop relaunches a shell that keeps exiting, and stops
# once the compositor's Wayland socket is gone (C's back-off loop).
c_loop=$REPO_ROOT/os/shell/data/jarvis-shell-loop
if [ -f "$c_labwc/autostart" ] && [ -f "$c_loop" ]; then
  check "autostart backgrounds C's loop" grep -qx '/usr/share/jarvis-shell/jarvis-shell-loop &' "$c_labwc/autostart"
  mkdir -p "$tmp/bin" "$tmp/xdg"
  : > "$tmp/xdg/wayland-test"
  # The fake shell exits at once; on its third run it removes the socket.
  printf '#!/bin/sh\necho run >> "%s/runs"\n[ "$(wc -l < "%s/runs")" -ge 3 ] && rm -f "%s/xdg/wayland-test"\nexit 1\n' \
    "$tmp" "$tmp" "$tmp" > "$tmp/bin/jarvis-shell"
  chmod +x "$tmp/bin/jarvis-shell"
  XDG_RUNTIME_DIR="$tmp/xdg" WAYLAND_DISPLAY=wayland-test JARVIS_SHELL_BIN="$tmp/bin/jarvis-shell" \
    JARVIS_LOOP_SLEEP=true perl -e 'alarm 10; exec @ARGV' sh "$c_loop" || true
  check "relaunch loop restarts the shell, then stops with the socket" test "$(wc -l < "$tmp/runs")" -eq 3
else
  echo "SKIP: Plan C's os/shell/data/labwc/autostart or jarvis-shell-loop not landed yet" >&2
fi


# The compositor must inherit the installed keyboard before it starts.
keyboard_session=$inc/usr/local/bin/labwc
check "keyboard session executable" test -x "$keyboard_session"
mkdir -p "$tmp/keyboard"
printf 'XKBLAYOUT="ara"\nXKBVARIANT="azerty"\n' > "$tmp/keyboard/default"
cat > "$tmp/keyboard/compositor" <<'EOF'
#!/bin/sh
printf '%s:%s:%s\n' "$XKB_DEFAULT_LAYOUT" "$XKB_DEFAULT_VARIANT" "$*"
EOF
chmod +x "$tmp/keyboard/compositor"
check_keyboard() {
  local result
  result=$(LABWC_KEYBOARD_FILE="$tmp/keyboard/default" LABWC_BIN="$tmp/keyboard/compositor" sh "$keyboard_session" --debug) || return
  test "$result" = 'ara:azerty:--merge-config --debug'
}
check "labwc inherits layout and variant and forwards arguments" check_keyboard
printf 'XKBLAYOUT="us"\nXKBVARIANT=""\n' > "$tmp/keyboard/default"
check_keyboard_default() {
  local result
  result=$(LABWC_KEYBOARD_FILE="$tmp/keyboard/default" LABWC_BIN="$tmp/keyboard/compositor" XKB_DEFAULT_VARIANT=stale sh "$keyboard_session") || return
  test "$result" = 'us::--merge-config'
}
check "empty variant clears inherited variant" check_keyboard_default

check "labwc merges user config over ours" \
  grep -Fq 'exec "${LABWC_BIN:-/usr/bin/labwc}" --merge-config "$@"' "$keyboard_session"

finish
