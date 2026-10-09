#!/bin/bash
# Runs inside debian:trixie (see cu-headless.sh). Starts a D-Bus session,
# the AT-SPI bus and a headless labwc, then the end-to-end test.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends labwc wev zenity foot at-spi2-core dbus dbus-bin \
  fonts-dejavu-core xkb-data procps >/dev/null
useradd -m -u 1000 tester
cat >/home/tester/session.sh <<'EOF'
set -euo pipefail
export XDG_RUNTIME_DIR=/tmp/xdg-tester
mkdir -m 700 -p "$XDG_RUNTIME_DIR"
export WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 WLR_HEADLESS_OUTPUTS=1
export GTK_A11Y=atspi NO_AT_BRIDGE=0
/usr/libexec/at-spi-bus-launcher --launch-immediately &
labwc >/tmp/labwc.log 2>&1 &
compositor=$!
trap 'kill "$compositor" 2>/dev/null || true; cat /tmp/labwc.log' EXIT
for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
[ -S "$XDG_RUNTIME_DIR/wayland-0" ] || { echo "labwc socket did not appear" >&2; exit 1; }
export WAYLAND_DISPLAY=wayland-0
JARVIS_CU_INTEGRATION=1 JARVIS_CU_BIN=/work/jarvis-cu /work/cu-e2e.test -test.v -test.timeout 5m
EOF
chown tester /home/tester/session.sh
su tester -c 'dbus-run-session -- bash /home/tester/session.sh'
