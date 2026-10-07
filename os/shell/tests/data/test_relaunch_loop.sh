#!/bin/sh
# ctest relaunch_loop: drives data/jarvis-shell-loop with a fake shell, a fake
# clock and a fake sleep. Usage: test_relaunch_loop.sh <path to jarvis-shell-loop>
set -eu
loop="$1"
T=$(mktemp -d /tmp/jsh-loop-XXXXXX)
trap 'rm -rf "$T"' EXIT
export XDG_RUNTIME_DIR="$T" WAYLAND_DISPLAY=wayland-test
SOCKET="$T/wayland-test"

cat > "$T/fake-shell" <<'EOF'
#!/bin/sh
# Counts runs, advances the fake clock by this run's duration, and removes the
# Wayland socket (labwc exiting) on run $STOP_AFTER.
n=$(( $(cat "$T/runs") + 1 )); echo "$n" > "$T/runs"
d=$(echo "$DURATIONS" | cut -d' ' -f"$n"); [ -n "$d" ] || d=0
echo $(( $(cat "$T/time") + d )) > "$T/time"
if [ "$n" -ge "$STOP_AFTER" ]; then rm -f "$SOCKET"; fi
exit 1
EOF
cat > "$T/fake-sleep" <<'EOF'
#!/bin/sh
printf '%s ' "$1" >> "$T/sleeps"
echo $(( $(cat "$T/time") + $1 )) > "$T/time"
EOF
chmod +x "$T/fake-shell" "$T/fake-sleep"
export T SOCKET JARVIS_SHELL_BIN="$T/fake-shell" JARVIS_LOOP_SLEEP="$T/fake-sleep" JARVIS_LOOP_NOW="cat $T/time"

reset_state() { echo 0 > "$T/runs"; echo 1000 > "$T/time"; : > "$T/sleeps"; }

# 1. Backoff doubles to 30 s, resets after a 100 s run, and the loop exits
#    (without sleeping) once the socket is gone after run 9.
reset_state; touch "$SOCKET"
DURATIONS="0 0 0 0 0 0 0 100 0" STOP_AFTER=9 sh "$loop"
runs=$(cat "$T/runs"); sleeps=$(cat "$T/sleeps")
[ "$runs" = 9 ] || { echo "FAIL backoff: expected 9 runs, got $runs"; exit 1; }
[ "$sleeps" = "1 2 4 8 16 30 30 1 " ] || { echo "FAIL backoff: sleeps were '$sleeps'"; exit 1; }

# 2. No Wayland socket (labwc already gone): the shell is never started.
reset_state; rm -f "$SOCKET"
DURATIONS="" STOP_AFTER=1 sh "$loop"
[ "$(cat "$T/runs")" = 0 ] || { echo "FAIL socket: the shell started without a compositor"; exit 1; }

echo "relaunch loop: backoff and exit-with-labwc OK"
