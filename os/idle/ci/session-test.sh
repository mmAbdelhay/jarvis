#!/usr/bin/env bash
# Linux CI only (M2 §11.16): jarvis-idle-testhooks in a headless labwc must run
# the locker once the seat has been idle for 1 s (ext-idle-notify-v1), and run
# it again after it exits 1 (lost lock). No logind in CI: idle only.
set -euo pipefail

build="$PWD/os/idle/build"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -m 0700 "$work/run"
mkdir "$work/labwc"
: > "$work/runs"

cat > "$work/lock.sh" <<EOF
#!/bin/sh
echo run >> "$work/runs"
echo locked
[ "\$(wc -l < "$work/runs")" -ge 2 ] && exit 0
exit 1
EOF
chmod +x "$work/lock.sh"

cat > "$work/session.sh" <<EOF
#!/bin/sh
"$build/src/jarvis-idle-testhooks" --test-lock-after-seconds 1 --test-lock-command "$work/lock.sh" &
i=0
while [ "\$(wc -l < "$work/runs")" -lt 2 ] && [ "\$i" -lt 200 ]; do sleep 0.1; i=\$((i + 1)); done
labwc --exit
EOF
chmod +x "$work/session.sh"

XDG_RUNTIME_DIR="$work/run" WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1 \
  WLR_LIBINPUT_NO_DEVICES=1 timeout 60 labwc -C "$work/labwc" -s "$work/session.sh" || true

test "$(wc -l < "$work/runs")" -ge 2
echo "jarvis-idle: idle lock and relaunch OK"
