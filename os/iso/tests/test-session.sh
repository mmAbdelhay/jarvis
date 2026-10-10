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
kr=$tmp/live/home/jarvis/.local/share/keyrings
check "live boots get an unlocked login keyring with no password (plain text format)" \
  grep -qx '\[keyring\]' "$kr/login.keyring"
check "the live login keyring holds no secret and never locks" \
  bash -c '! grep -q "^secret=" "$1" && grep -qx lock-on-idle=false "$1" && grep -qx lock-after=false "$1"' _ "$kr/login.keyring"
check "the live login keyring is the default collection (no new-keyring prompt)" grep -qx login "$kr/default"
check "the live keyring files are private" test "$(stat -c %a "$kr/login.keyring" 2>/dev/null || stat -f %Lp "$kr/login.keyring")" = 600
printf '[keyring]\ndisplay-name=Login\n[1]\nsecret=kept\n' > "$kr/login.keyring"
env LIVE_ROOT="$tmp/live" sh "$live"
check "live-config never overwrites an existing login keyring" grep -qx 'secret=kept' "$kr/login.keyring"
for a in labwc labwc-classic; do
  check "$a autostart starts no second keyring daemon (no --unlock)" \
    bash -c '! grep -v "^[[:space:]]*#" "$1" | grep -q -- "--unlock"' _ "$inc/etc/xdg/$a/autostart"
  check "$a autostart completes the keyring daemon PAM started" \
    grep -qx 'gnome-keyring-daemon --start --components=pkcs11,secrets >/dev/null 2>&1 || true' "$inc/etc/xdg/$a/autostart"
done
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
check "Super focuses the shell through the session dispatcher (§6 #14, M4 §2)" grep -Fxq $'Super_L\tExecute\t/usr/libexec/jarvis/jarvis-session-key --focus' <<<"$ours"
check "Ctrl+Alt+T opens foot" grep -Fxq $'C-A-t\tExecute\tfoot' <<<"$ours"
check "Super acts on release (so Super+key chords still work)" python3 - "$inc/etc/xdg/labwc/rc.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
kb = ET.parse(sys.argv[1]).getroot().find("keyboard")
assert [b for b in kb.findall("keybind") if b.get("key") == "Super_L"][0].get("onRelease") == "yes"
PY
check "Super+L runs jarvis-lock directly (including live boots without jarvis-idle)" grep -Fxq $'W-l\tExecute\tjarvis-lock' <<<"$ours"
check "Super+Space is push-to-talk through the dispatcher (M3 §3, M4 §2)" grep -Fxq $'W-space\tExecute\t/usr/libexec/jarvis/jarvis-session-key --voice' <<<"$ours"
check "no keybind calls jarvis-shell directly (it would cover the classic desktop)" \
  python3 - "$inc/etc/xdg/labwc/rc.xml" <<'PYDIRECT'
import sys, xml.etree.ElementTree as ET
commands = [a.get("command", "") for a in ET.parse(sys.argv[1]).iter("action")]
assert not any(c.split() and c.split()[0] == "jarvis-shell" for c in commands), commands
PYDIRECT
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
c = t.index(". /usr/share/jarvis-session/labwc/autostart")
assert a < d < b < c, (a, d, b, c)
PYORDER
if [ -f "$c_labwc/rc.xml" ]; then
  # Route the same shell arguments through the full/classic dispatcher.
  routed=$(printf '%s\n' "${ours//\/usr\/libexec\/jarvis\/jarvis-session-key /jarvis-shell }" | sort)
  check "every jarvis-shell bind is ours, same arguments" \
    test -z "$(comm -23 <(keybinds "$c_labwc/rc.xml") <(printf '%s\n' "$routed"))"
else
  echo "SKIP: Plan C's os/shell/data/labwc/rc.xml not landed yet" >&2
fi

check "autostart parses" sh -n "$inc/etc/xdg/labwc/autostart"
check "autostart starts the shell through the fallback guard (M4 §2)" \
  grep -Fxq '. /usr/share/jarvis-session/labwc/autostart' "$auto"
check "autostart no longer starts the bare loop" \
  bash -c '! grep -Fxq ". /usr/share/jarvis-shell/labwc/autostart" "$1"' _ "$auto"
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

# Without a GPU Mesa accelerates, labwc and the Qt clients draw in software
# (pixman, Qt Quick software) instead of llvmpipe: idle RAM, criterion 2.
printf '#!/bin/sh\nprintf "%%s:%%s\\n" "${WLR_RENDERER:-}" "${QT_QUICK_BACKEND:-}"\n' > "$tmp/keyboard/renderer"
chmod +x "$tmp/keyboard/renderer"
fake_card() { # fake_card ROOT CARD DRIVER [VIRTIO_FEATURES]
  mkdir -p "$1/devices/$2" "$1/drivers/$3" "$1/drm/$2"
  ln -s "$1/drivers/$3" "$1/devices/$2/driver"
  ln -s "$1/devices/$2" "$1/drm/$2/device"
  if [ -n "${4:-}" ]; then mkdir -p "$1/devices/$2/virtio1"; printf '%s\n' "$4" > "$1/devices/$2/virtio1/features"; fi
}
renderer_for() { # renderer_for ROOT -> "WLR_RENDERER:QT_QUICK_BACKEND"
  env -u WLR_RENDERER -u QT_QUICK_BACKEND LABWC_DRM_DIR="$1/drm" LABWC_KEYBOARD_FILE=/nonexistent \
    LABWC_BIN="$tmp/keyboard/renderer" sh "$keyboard_session"
}
fake_card "$tmp/gl-none" card0 virtio-pci 0000000100000000
mkdir -p "$tmp/gl-none/drm/card0-Virtual-1"
check "virtio-gpu without virgl draws in software (pixman, Qt Quick software)" \
  test "$(renderer_for "$tmp/gl-none")" = 'pixman:software'
fake_card "$tmp/gl-virgl" card0 virtio-pci 1000000100000000
check "virtio-gpu with virgl keeps hardware GL" test "$(renderer_for "$tmp/gl-virgl")" = ':'
fake_card "$tmp/gl-simple" card0 simpledrm
check "simpledrm draws in software" test "$(renderer_for "$tmp/gl-simple")" = 'pixman:software'
fake_card "$tmp/gl-hybrid" card0 simpledrm
fake_card "$tmp/gl-hybrid" card1 i915
check "an Intel GPU keeps hardware GL" test "$(renderer_for "$tmp/gl-hybrid")" = ':'
fake_card "$tmp/gl-amd" card1 amdgpu
check "an AMD GPU keeps hardware GL" test "$(renderer_for "$tmp/gl-amd")" = ':'
mkdir -p "$tmp/gl-empty/drm"
check "no DRM card draws in software" test "$(renderer_for "$tmp/gl-empty")" = 'pixman:software'
check "an explicit renderer choice wins" test "$(LABWC_DRM_DIR="$tmp/gl-none/drm" LABWC_KEYBOARD_FILE=/nonexistent \
  LABWC_BIN="$tmp/keyboard/renderer" WLR_RENDERER=gles2 QT_QUICK_BACKEND=rhi sh "$keyboard_session")" = 'gles2:rhi'

finish
