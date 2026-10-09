#!/usr/bin/env bash
# The computer-use container harness (Task X10) is wired to the real session
# files and covers every criterion it claims. It runs only on Linux; this
# checks it statically anywhere.
source "$(dirname "$0")/lib.sh"
h=$ISO_DIR/cu
for f in run.sh in-container.sh session.sh; do check "$f parses" bash -n "$h/$f"; done
check "run.sh executable" test -x "$h/run.sh"
check "unprivileged container" bash -c '! grep -q -- "--privileged" "$1"' _ "$h/run.sh"
check "Linux only (never the dev Mac)" grep -q 'uname -s' "$h/run.sh"
for f in etc/xdg/labwc/rc.xml etc/xdg/labwc/environment usr/local/bin/labwc etc/xdg/labwc/autostart; do
  check "uses the ISO's $f" grep -qF "$f" "$h/in-container.sh"
done
for p in jarvisd jarvis-cu jarvis-lock jarvis-session; do check "installs the real $p" grep -qw "$p" "$h/in-container.sh"; done
check "headless pixman labwc" grep -q 'WLR_BACKENDS=headless' "$h/session.sh"
check "jarvisd's brain is the scripted vision model" grep -q 'fakevision.mjs' "$h/session.sh"
for case in "criterion 1: Pictures/beach.png is a 640x480 PNG" \
  "criterion 2: computer use is off by default (no screen tools offered)" \
  "criterion 4: exactly one session card, 'Let Jarvis use … to: …'" \
  "criterion 4: input refused while a terminal has focus (excluded)" \
  "criterion 5: a consequential card before the export" "criterion 5: denying it leaves no file" \
  "criterion 6: screenshots show only the allowed window, with the terminal in view" \
  "criterion 7: the stuck loop stops before the seventh identical look" \
  "criterion 8: no screenshot is stored (no PNG data in jarvis's directories)" \
  "criterion 9: Super+L ends computer use within 2 s" \
  "a plain Node process is refused on cu.sock" "Node running jarvisd's script with another argv is refused" \
  "cu.sock is 0600"; do
  check "covers: $case" grep -qF "\"$case\"" "$h/session.sh"
done
check "every scripted turn the harness runs exists" python3 - "$ISO_DIR/smoke/assets/cu/cu-gimp.json" "$h/session.sh" <<'PY'
import json, re, sys
names = {t["name"] for t in json.load(open(sys.argv[1]))["turns"]}
used = set(re.findall(r'cuc \w[\w-]* "\$report" (\w+)', open(sys.argv[2]).read()))
assert used and used <= names, (used, names)
PY
finish
