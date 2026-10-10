#!/usr/bin/env bash
# As "tester" inside dbus-run-session (in-container.sh): a headless labwc
# session with the ISO's labwc files; jarvis-cu and jarvisd started the way
# their units would; jarvisd's brain is fakevision.mjs (a scripted vision
# model on loopback Ollama); GIMP and a terminal on screen. Checks every v1.1
# criterion that needs no physical input. Results in /out/results.txt.
set -uo pipefail
assets=/src/os/iso/smoke/assets
cu=$assets/cu
node=/usr/lib/jarvis/node/bin/node
out=/out
rt=$XDG_RUNTIME_DIR
report=$out/fakevision-report.json
export WAYLAND_DISPLAY=wayland-0 XDG_CURRENT_DESKTOP=labwc:wlroots
failures=0
check() {
  local name=$1; shift
  if "$@"; then echo "ok   $name" | tee -a "$out/results.txt"
  else echo "FAIL $name" | tee -a "$out/results.txt"; failures=$((failures + 1)); fi
}
wait_for() { local secs=$1 _; shift; for _ in $(seq "$secs"); do "$@" && return 0; sleep 1; done; return 1; }
ctl() { "$node" "$assets/jarvisctl.mjs" "$@"; }
cuc() { "$node" "$cu/cucheck.mjs" "$@"; }
# blocked NAME REASON — a check that cannot run yet. Recorded, not claimed, not a failure.
blocked() { echo "BLOCKED $1 ($2)" | tee -a "$out/results.txt"; blocked_n=$((blocked_n + 1)); }
blocked_n=0
# shellcheck source=scan.sh
source "$(dirname "$0")/scan.sh"
turn() { # turn NAME TEXT [jarvisctl cu flags...] — one computer-use turn, log in $out/turn-NAME.log
  local name=$1 text=$2; shift 2
  ctl cu --text "$text" --timeout 600 "$@" > "$out/turn-$name.log" 2>&1 || true
}
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

# 1. The session: the ISO's labwc config plus test-only window placement.
mkdir -p "$HOME/.config/labwc" "$HOME/.config/GIMP/3.0" "$HOME/Pictures"
cp "$cu/labwc-rules.xml" "$HOME/.config/labwc/rc.xml"
sh "$cu/install-gimprc.sh" "$HOME/.config/GIMP/3.0"
sh "$cu/install-user-dirs.sh" "$HOME"
WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1 \
  LABWC_KEYBOARD_FILE=/nonexistent /usr/local/bin/labwc > "$out/labwc.log" 2>&1 &
pids+=($!)
check "labwc starts headless with the ISO config" wait_for 30 test -S "$rt/wayland-0"
wlr-randr --output HEADLESS-1 --custom-mode 1280x800 > /dev/null 2>&1 || true

# 2. The protocols jarvis-cu needs (design §3.1), offered by default.
globals=$(wayland-info 2>/dev/null | grep -o "interface: '[a-z_0-9]*'" | sort -u)
for g in zwlr_virtual_pointer_manager_v1 zwp_virtual_keyboard_manager_v1 zwlr_foreign_toplevel_manager_v1 \
  ext_idle_notifier_v1 ext_session_lock_manager_v1; do
  check "labwc offers $g" grep -q "'$g'" <<<"$globals"
done
check "labwc offers a capture protocol" grep -qE "'(zwlr_screencopy_manager_v1|ext_image_copy_capture_manager_v1)'" <<<"$globals"

# 3. jarvis-cu, as jarvis-cu.service starts it.
/usr/libexec/jarvis/jarvis-cu > "$out/jarvis-cu.log" 2>&1 &
pids+=($!)
sock=$rt/jarvis/cu.sock
check "jarvis-cu listens at \$XDG_RUNTIME_DIR/jarvis/cu.sock" wait_for 15 test -S "$sock"
check "cu.sock is 0600" test "$(stat -c %a "$sock")" = 600

# 4. The scripted vision model, and jarvisd on it.
gimp_app=$(basename "$(ls /usr/share/applications/*gimp*.desktop | head -n1)" .desktop)
echo "$gimp_app" > "$out/gimp-desktop-id.txt"
GIMP_APP=$gimp_app "$node" "$cu/fakevision.mjs" --script "$cu/cu-gimp.json" --report "$report" --port 11500 \
  > "$out/fakevision.log" 2>&1 &
pids+=($!)
check "the scripted vision model listens on loopback" wait_for 15 bash -c 'ss -Hltn | grep -q "127.0.0.1:11500 "'
mkdir -p "$HOME/.config/jarvis"
install -m0600 "$cu/jarvis.yaml" "$HOME/.config/jarvis/jarvis.yaml"
"$node" /usr/lib/jarvis/daemon/jarvisd.mjs run > "$out/jarvisd.log" 2>&1 &
pids+=($!)
check "jarvisd is up on the scripted provider" ctl wait --timeout 90

# 5. Review Focus 3: only jarvisd may drive the helper.
check "a plain Node process is refused on cu.sock" test "$(CU_SOCK=$sock "$node" "$cu/peer-probe.mjs")" = REFUSED
check "Node running jarvisd's script with another argv is refused" \
  test "$(CU_SOCK=$sock "$node" --import "file://$cu/peer-probe.mjs" /usr/lib/jarvis/daemon/jarvisd.mjs run)" = REFUSED

# 6. A terminal (never allowed) and GIMP with beach.xcf.
check "beach.xcf made by GIMP's batch mode" env JARVIS_NODE="$node" "$cu/make-fixture.sh" "$HOME"
foot --title cu-secret-terminal sh -c 'echo SECRET-CANARY; exec sleep infinity' > /dev/null 2>&1 &
pids+=($!)
sleep 2
gimp -n --no-splash "$HOME/beach.xcf" > "$out/gimp.log" 2>&1 &
pids+=($!)
check "GIMP runs" wait_for 90 pgrep -u "$(id -u)" -f "gimp.* --no-splash $HOME/beach.xcf"
sleep 30 # first start: fonts, plug-ins, the image window

# 7. Criterion 2: off by default.
turn off "cu-off: look at my screen"
check "criterion 2: computer use is off by default (no screen tools offered)" cuc no-screen-tools "$report" off
check "computer use enabled for the scripted provider" ctl cu-enable --provider scripted

# 8. Criteria 4 and 6: one session card; only GIMP visible; a click on the terminal refused.
turn probe "cu-probe: look at the GIMP window"
check "criterion 4: exactly one session card, 'Let Jarvis use … to: …'" cuc card "$out/turn-probe.log" begin --title-has cu-probe
# Under contracts U-1 an ordinary screenshot is a fullscreen GIMP frame: the mask is
# vacuous there (no evidence, neither a leak nor a pass), and no point of it is outside
# GIMP, so the scripted click lands beyond the screenshot and V refuses it (outside)
# before it reaches jarvis-cu (the excluded turn in section 11 exercises the helper's
# own refusal of input while a foreign window has focus). The privacy evidence is the all-black capture in section 11.
check "the probe turn ran as scripted (a click beyond the screenshot is refused: outside)" cuc turn "$report" probe --images

# 9-10. Criteria 1 and 5: export through GIMP's two Export dialogs, mouse only
# (GTK3 apps ignore virtual-keyboard keys under headless labwc, e2e README).
# Export Image's Export button is consequential (save): its card comes before
# the click. The deny turn denies it and cancels; the export turn approves it
# and Export in "Export Image as PNG" (GIMP's file-png plug-in) writes the file.
png=$HOME/Pictures/beach.png
turn deny "cu-deny: export beach as PNG to Pictures" --consequential deny --absent "$png"
check "the deny turn ran as scripted (card denied, then Cancel)" cuc turn "$report" deny
check "criterion 5: a consequential card before the export click" \
  cuc card "$out/turn-deny.log" consequential --absent --title-has Export
check "criterion 5: denying it leaves no file" test ! -e "$png"
turn export "open the GIMP image beach.xcf and export it as PNG to Pictures" --absent "$png"
check "the export turn ran as scripted" cuc turn "$report" export
check "criterion 5: the approved export asked first, before the file existed" \
  cuc card "$out/turn-export.log" consequential --absent --title-has Export
check "criterion 1: Pictures/beach.png is a 640x480 PNG" wait_for 20 cuc png "$png" 640 480

# 11. Criteria 6 and 4 in one turn, built on merged U/V semantics (session.go
# checkFocus, computer-use.ts run/waitForResume). GIMP is activated at begin, so
# every window here opens after the turn's first look:
#  - a foreign window that is neither allowed nor excluded takes focus during the
#    held second look. jarvis-cu does not pause for it, but Capture blanks the frame
#    (the focused window is not allowed): the non-vacuous all-black evidence;
#  - a key sent right then is refused by the helper itself (outside: the focused
#    window is not one of the allowed apps; expectError, checked by the turn check);
#  - then a terminal takes focus. jarvis-cu pauses the session (excluded-focus),
#    and jarvisd holds the next action (the held ctrl+shift+e) until the user
#    resumes or stops. The harness stops it (cu-stop, as Esc / Take over would),
#    and checks that the key never reached GIMP (no audit entry).
audit=$HOME/.local/state/jarvis/audit.jsonl
# Not in policy/apps.go's terminals, and no assistant or distro prefix.
foreign_app="cu-foreign-viewer"
{ ctl cu --text "cu-excluded: press a key in GIMP" --timeout 600 > "$out/turn-excluded.log" 2>&1
  touch "$out/turn-excluded.done"; } &
excluded_turn=$!
check "the excluded turn's held look is issued (first look done)" wait_for 60 cuc step "$report" excluded 1
foot --app-id "$foreign_app" --title cu-foreign-viewer sh -c 'echo SECRET-CANARY; exec sleep infinity' > /dev/null 2>&1 &
foreign=$!
check "the excluded turn's refused key (outside) and its held key are issued (black look done)" wait_for 60 cuc step "$report" excluded 3
t0=$(date +%s%3N)
foot --title cu-excluded-terminal sh -c 'exec sleep infinity' > /dev/null 2>&1 &
excluded=$!
check "criterion 4: a terminal taking focus pauses computer use (excluded-focus)" \
  wait_for 15 cuc paused "$out/turn-excluded.log" excluded-focus --since "$t0" --within 5000
sleep 9 # the key's 8 s hold: jarvisd now holds it in the paused session
check "the paused session is stopped (cu-stop)" ctl cu-stop
check "the excluded turn ends after cu-stop" wait_for 30 test -e "$out/turn-excluded.done"
wait "$excluded_turn" 2>/dev/null || true
kill "$excluded" "$foreign" 2>/dev/null || true
check "criterion 4: no key reached GIMP while the terminal had focus" bash -c '! grep -qF "ctrl+shift+e" "$1"' _ "$audit"
check "criterion 6: with a foreign window focused the capture is entirely black (non-vacuous mask evidence)" \
  cuc turn "$report" excluded --evidence
sleep 2

# 12. Criterion 7: a loop that changes nothing stops. One harmless key (Select None,
# also the audited screen action of criterion 8), then 7 looks: merged V refuses the
# 5th identical capture (CU_STUCK_REPEATS) and every later call, without a screenshot.
turn stuck "cu-stuck: keep looking"
check "criterion 7: the stuck loop stops before the seventh identical look" cuc looks-below "$report" stuck 7

# 13. Criterion 9: Super+L (labwc's keybind runs jarvis-lock) ends computer use.
ctl cu --text "cu-lock: hold the session" --timeout 120 > "$out/turn-lock.log" 2>&1 &
lock_turn=$!
check "the lock turn is running" wait_for 60 cuc active "$out/turn-lock.log"
t0=$(date +%s%3N)
wtype -M logo -k l -m logo
check "criterion 9: Super+L ends computer use within 2 s" \
  wait_for 10 cuc paused "$out/turn-lock.log" locked --since "$t0" --within 2000
check "the lock screen is up" wait_for 10 pgrep -u "$(id -u)" -x jarvis-lock
sleep 3
wtype 'correct horse'
wtype -k Return
check "the session unlocks" wait_for 15 bash -c '! pgrep -u "$(id -u)" -x jarvis-lock'
wait "$lock_turn" 2>/dev/null || true

# 14. Criteria 6 and 8 at rest.
check "criterion 8: the audit log records the goal" grep -qF 'beach.xcf' "$audit"
check "criterion 8: the audit log records screen actions" grep -qE '"tool":"screen[._](click|key|type)' "$audit"
jarvis_dirs=("$HOME/.local/state/jarvis" "$HOME/.local/share/jarvis" "$HOME/.config/jarvis" "$HOME/.cache/jarvis" "$rt/jarvis")
# Logs too: the daemon's and helper's output (the journal on the ISO) and the
# jarvisctl event logs (what clients were pushed). Base64 and raw PNG signatures.
scan_logs=("$out/jarvisd.log" "$out/jarvis-cu.log" "$out"/turn-*.log)
not_stored() {
  [ -z "$(png_hits "${jarvis_dirs[@]}" "${scan_logs[@]}")" ] && [ -z "$(png_files "${jarvis_dirs[@]}")" ]
}
# Control: the scan must see a planted PNG even with a missing directory listed.
control=$(mktemp -d)
printf 'x iVBORw0KGgo y' > "$control/b64"; printf '\x89PNG\r\n' > "$control/raw"
check "the privacy scan detects planted PNG data (with a missing directory in the list)" \
  test "$(png_hits "$control" /nonexistent-dir | wc -l)" -eq 2
rm -rf "$control"
# jarvisd may write nothing to stdout (its log goes elsewhere): the file must exist; the turn logs must have content.
check "the logs the privacy scan reads exist" test -e "$out/jarvisd.log" -a -s "$out/turn-probe.log"
check "criterion 8: no screenshot is stored (no PNG data in jarvis's directories or the logs)" not_stored
check "criterion 6: no screenshot outside computer-use turns, none leaked" cuc no-leaks "$report" --min-verified 1

if [ "$failures" -gt 0 ]; then
  { echo "--- jarvisd.log (tail)"; tail -n 80 "$out/jarvisd.log"
    echo "--- jarvis-cu.log (tail)"; tail -n 40 "$out/jarvis-cu.log"; } >&2
  echo "$failures failure(s)"
  exit 1
fi
if [ "$blocked_n" -gt 0 ]; then
  # Not green: the v1.1 export and consequential-action gating are unproven end to end.
  # CU_FAIL_ON_BLOCKED=1 (release tags) turns this into a failure; CI also warns.
  echo "passed, but $blocked_n BLOCKED criteria are NOT verified (release blocker: GIMP export not yet proven end to end)"
  [ "${CU_FAIL_ON_BLOCKED:-0}" = 1 ] && exit 1
  exit 0
fi
echo "all passed"
