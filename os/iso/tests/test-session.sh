#!/usr/bin/env bash
# greetd, labwc keybinds and autostart, and Plan C's relaunch loop.
source "$(dirname "$0")/lib.sh"
inc=$ISO_DIR/config/includes.chroot_after_packages
c_labwc=$REPO_ROOT/os/shell/data/labwc
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

check "greetd autologins jarvis into labwc" python3 - "$inc/etc/greetd/config.toml" <<'PY'
import sys, tomllib
c = tomllib.load(open(sys.argv[1], "rb"))
assert c["initial_session"] == {"command": "labwc", "user": "jarvis"}, c
assert c["default_session"]["user"] == "_greetd", c
PY

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
check "Super focuses the shell (§6 #14)" grep -qxP 'Super_L\tExecute\tjarvis-shell --focus' <<<"$ours"
check "Ctrl+Alt+T opens foot" grep -qxP 'C-A-t\tExecute\tfoot' <<<"$ours"
check "Super acts on release (so Super+key chords still work)" python3 - "$inc/etc/xdg/labwc/rc.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
kb = ET.parse(sys.argv[1]).getroot().find("keyboard")
assert [b for b in kb.findall("keybind") if b.get("key") == "Super_L"][0].get("onRelease") == "yes"
PY
if [ -f "$c_labwc/rc.xml" ]; then
  check "our binds equal Plan C's rc.xml" test "$ours" = "$(keybinds "$c_labwc/rc.xml")"
else
  echo "SKIP: Plan C's os/shell/data/labwc/rc.xml not landed yet" >&2
fi

check "autostart parses" sh -n "$inc/etc/xdg/labwc/autostart"
check "autostart sources C's relaunch loop" grep -qx '. /usr/share/jarvis-shell/labwc/autostart' "$inc/etc/xdg/labwc/autostart"
check "environment is KEY=VALUE lines" bash -c "! grep -Ev '^(#.*|[A-Z_]+=.*|)$' '$inc/etc/xdg/labwc/environment'"
check "Qt uses Wayland" grep -qx 'QT_QPA_PLATFORM=wayland' "$inc/etc/xdg/labwc/environment"

# Review Focus 2: C's loop relaunches a shell that keeps exiting.
if [ -f "$c_labwc/autostart" ]; then
  mkdir -p "$tmp/bin"
  printf '#!/bin/sh\necho run >> "%s/runs"\nexit 1\n' "$tmp" > "$tmp/bin/jarvis-shell"
  chmod +x "$tmp/bin/jarvis-shell"
  PATH="$tmp/bin:$PATH" setsid sh -c '. "$1"; sleep 3.5; kill 0' sh "$c_labwc/autostart" 2>/dev/null || true
  check "relaunch loop restarts the shell" test "$(wc -l < "$tmp/runs")" -ge 3
else
  echo "SKIP: Plan C's os/shell/data/labwc/autostart not landed yet" >&2
fi

finish
