#!/bin/sh
# ctest relaunch_loop: drives data/jarvis-shell-loop with fake jarvis-shell and
# jarvis-classic programs, a fake clock and a fake sleep.
# Usage: test_relaunch_loop.sh <path to jarvis-shell-loop>
set -eu
loop="$1"
T=$(mktemp -d /tmp/jsh-loop-XXXXXX)
trap 'rm -rf "$T"' EXIT
export XDG_RUNTIME_DIR="$T" WAYLAND_DISPLAY=wayland-test
SOCKET="$T/wayland-test"
MARKER="$T/jarvis/classic-fallback"

cat > "$T/fake-prog" <<'EOF'
#!/bin/sh
# $1 = name. Logs the name, counts runs, advances the fake clock by this run's
# duration and removes the Wayland socket (labwc exiting) on run $STOP_AFTER.
n=$(( $(cat "$T/runs") + 1 )); echo "$n" > "$T/runs"
printf '%s ' "$1" >> "$T/log"
d=$(echo "$DURATIONS" | cut -d' ' -f"$n"); [ -n "$d" ] || d=0
echo $(( $(cat "$T/time") + d )) > "$T/time"
if [ "$n" -ge "$STOP_AFTER" ]; then rm -f "$SOCKET"; fi
exit 1
EOF
printf '#!/bin/sh\nexec "$T/fake-prog" shell\n' > "$T/fake-shell"
printf '#!/bin/sh\nexec "$T/fake-prog" classic\n' > "$T/fake-classic"
cat > "$T/fake-sleep" <<'EOF'
#!/bin/sh
printf '%s ' "$1" >> "$T/sleeps"
echo $(( $(cat "$T/time") + $1 )) > "$T/time"
EOF
chmod +x "$T/fake-prog" "$T/fake-shell" "$T/fake-classic" "$T/fake-sleep"
export T SOCKET JARVIS_SHELL_BIN="$T/fake-shell" JARVIS_CLASSIC_BIN="$T/fake-classic" \
       JARVIS_LOOP_SLEEP="$T/fake-sleep" JARVIS_LOOP_NOW="cat $T/time"

reset_state() { echo 0 > "$T/runs"; echo 1000 > "$T/time"; : > "$T/sleeps"; : > "$T/log"; rm -rf "$T/jarvis"; }
expect() { [ "$2" = "$3" ] || { echo "FAIL $1: expected '$3', got '$2'"; exit 1; }; }

# 1. Exits more than 60 s apart: the shell keeps being relaunched with backoff
#    (1 s doubling to 30 s, reset after a 100 s run); no fallback.
reset_state; touch "$SOCKET"
DURATIONS="31 31 31 31 31 31 100 31" STOP_AFTER=8 sh "$loop"
expect backoff-runs "$(cat "$T/log")" "shell shell shell shell shell shell shell shell "
expect backoff-sleeps "$(cat "$T/sleeps")" "1 2 4 8 16 30 1 "
[ ! -e "$MARKER" ] || { echo "FAIL backoff: marker written without a crash loop"; exit 1; }

# 2. No Wayland socket (labwc already gone): nothing is started.
reset_state; rm -f "$SOCKET"
DURATIONS="" STOP_AFTER=1 sh "$loop"
expect no-socket "$(cat "$T/runs")" 0

# 3. Three exits within 60 s: the marker is written once and classic takes
#    over, with its own fresh backoff.
reset_state; touch "$SOCKET"
(umask 077; DURATIONS="0 0 0 0 0 0" STOP_AFTER=6 sh "$loop") 2> "$T/stderr"
expect fallback-runs "$(cat "$T/log")" "shell shell shell classic classic classic "
expect fallback-sleeps "$(cat "$T/sleeps")" "1 2 1 2 "
[ -f "$MARKER" ] || { echo "FAIL fallback: no marker at $MARKER"; exit 1; }

expect marker-mode "$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$MARKER")" 0o644
[ ! -s "$MARKER" ] || { echo "FAIL marker: not empty"; exit 1; }
expect fallback-log-lines "$(wc -l < "$T/stderr" | tr -d ' ')" 1

# 4. A long first run still counts when the next two exits come fast.
reset_state; touch "$SOCKET"
DURATIONS="31 0 0 0" STOP_AFTER=4 sh "$loop"
expect window-runs "$(cat "$T/log")" "shell shell shell classic "

# 5. A loop started in a session that already fell back runs classic only.
reset_state; touch "$SOCKET"; mkdir -p "$T/jarvis"; : > "$MARKER"
DURATIONS="0 0 0" STOP_AFTER=3 sh "$loop"
expect marker-runs "$(cat "$T/log")" "classic classic classic "

# 6. Classic session (shell and classic binaries are the same): rapid exits
#    never write the marker or log a shell failure, and just back off.
reset_state; touch "$SOCKET"
(JARVIS_SHELL_BIN="$T/fake-classic" DURATIONS="0 0 0 0" STOP_AFTER=4 sh "$loop") 2> "$T/stderr"
expect classic-session-runs "$(cat "$T/log")" "classic classic classic classic "
expect classic-session-sleeps "$(cat "$T/sleeps")" "1 2 4 "
[ ! -e "$MARKER" ] || { echo "FAIL classic session: marker written"; exit 1; }
[ ! -s "$T/stderr" ] || { echo "FAIL classic session: unexpected stderr"; exit 1; }

# 7. Run through jarvis-shell-guard, which owns the fallback: the loop neither
#    counts exits nor writes or empties the guard's marker.
reset_state; touch "$SOCKET"; mkdir -p "$T/g"
cp "$T/fake-shell" "$T/g/jarvis-shell-guard"
(JARVIS_SHELL_BIN="$T/g/jarvis-shell-guard" DURATIONS="0 0 0 0" STOP_AFTER=4 sh "$loop") 2> "$T/stderr"
expect guarded-runs "$(cat "$T/log")" "shell shell shell shell "
[ ! -e "$MARKER" ] || { echo "FAIL guarded: loop wrote the marker"; exit 1; }
mkdir -p "$T/jarvis"; printf 'reason=shell-failed\nsince=5\n' > "$MARKER"; chmod 0600 "$MARKER"
reset_state_keep() { echo 0 > "$T/runs"; : > "$T/log"; touch "$SOCKET"; }
reset_state_keep
JARVIS_SHELL_BIN="$T/g/jarvis-shell-guard" JARVIS_CLASSIC_BIN="$T/fake-classic" DURATIONS="0 0" STOP_AFTER=2 sh "$loop" 2>/dev/null
expect guarded-marker "$(cat "$MARKER")" "$(printf 'reason=shell-failed\nsince=5')"
expect guarded-marker-mode "$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$MARKER")" 0o600

echo "relaunch loop: backoff, classic fallback and exit-with-labwc OK"
