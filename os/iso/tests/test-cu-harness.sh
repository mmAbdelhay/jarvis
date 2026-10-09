#!/usr/bin/env bash
# The computer-use container harness (Task X10) is wired to the real session
# files and covers every criterion it claims. It runs only on Linux; this
# checks it statically anywhere.
source "$(dirname "$0")/lib.sh"
h=$ISO_DIR/cu
for f in run.sh in-container.sh session.sh scan.sh; do check "$f parses" bash -n "$h/$f"; done
check "run.sh executable" test -x "$h/run.sh"
check "unprivileged container" bash -c '! grep -q -- "--privileged" "$1"' _ "$h/run.sh"
check "Linux only (never the dev Mac)" grep -q 'uname -s' "$h/run.sh"
for f in etc/xdg/labwc/rc.xml etc/xdg/labwc/environment usr/local/bin/labwc etc/xdg/labwc/autostart; do
  check "uses the ISO's $f" grep -qF "$f" "$h/in-container.sh"
done
for p in jarvisd jarvis-cu jarvis-lock jarvis-session; do check "installs the real $p" grep -qw "$p" "$h/in-container.sh"; done
check "headless pixman labwc" grep -q 'WLR_BACKENDS=headless' "$h/session.sh"
check "jarvisd's brain is the scripted vision model" grep -q 'fakevision.mjs' "$h/session.sh"
for case in "criterion 2: computer use is off by default (no screen tools offered)" \
  "criterion 4: exactly one session card, 'Let Jarvis use … to: …'" \
  "criterion 4: input refused while a terminal has focus (excluded)" \
  "criterion 6: with a terminal focused the capture is entirely black (non-vacuous mask evidence)" \
  "criterion 7: the stuck loop stops before the seventh identical look" \
  "criterion 8: no screenshot is stored (no PNG data in jarvis's directories or the logs)" \
  "the privacy scan detects planted PNG data (with a missing directory in the list)" \
  "criterion 9: Super+L ends computer use within 2 s" \
  "a plain Node process is refused on cu.sock" "Node running jarvisd's script with another argv is refused" \
  "cu.sock is 0600"; do
  check "covers: $case" grep -qF "\"$case\"" "$h/session.sh"
done
# Contracts U-1 blocks the export/consequential-card criteria: they must be recorded
# as BLOCKED, never claimed as checks.
for case in "criterion 1: Pictures/beach.png is a 640x480 PNG" "criterion 5: a consequential card before the export" \
  "criterion 5: denying it leaves no file"; do
  check "blocked, not claimed: $case" bash -c 'grep -qF "blocked \"$1\"" "$2" && ! grep -qF "check \"$1\"" "$2"' _ "$case" "$h/session.sh"
done
check "the excluded turn starts the terminal after begin (held look, all-black)" python3 - "$ISO_DIR/smoke/assets/cu/cu-gimp.json" <<'PY'
import json, sys
t = next(t for t in json.load(open(sys.argv[1]))["turns"] if t["name"] == "excluded")
held = [s for s in t["steps"] if s.get("hold", 0) > 0 and s.get("mask", {}).get("mode") == "all-black"]
assert held and "mask" not in t, t
PY
# The privacy scan must not be fooled by a missing directory under pipefail.
scan_test() {
  set -o pipefail
  source "$ISO_DIR/cu/scan.sh"
  local d; d=$(mktemp -d)
  printf 'a iVBORw0KGgo b' > "$d/x"
  [ "$(png_hits "$d" /nonexistent-dir)" = "$d/x" ] || return 1
  rm "$d/x"; printf '\x89PNG\r\n' > "$d/raw"
  [ "$(png_hits /nonexistent-dir "$d")" = "$d/raw" ] || return 1
  rm "$d/raw"; echo clean > "$d/y"
  [ -z "$(png_hits "$d" /nonexistent-dir)" ] || return 1
  rm -rf "$d"
}
check "png_hits finds PNG data despite a missing directory, under pipefail" bash -c "$(declare -f scan_test); ISO_DIR=$ISO_DIR; scan_test"
check "every scripted turn the harness runs exists" python3 - "$ISO_DIR/smoke/assets/cu/cu-gimp.json" "$h/session.sh" <<'PY'
import json, re, sys
names = {t["name"] for t in json.load(open(sys.argv[1]))["turns"]}
used = set(re.findall(r'cuc \w[\w-]* "\$report" (\w+)', open(sys.argv[2]).read()))
assert used and used <= names, (used, names)
PY
finish
