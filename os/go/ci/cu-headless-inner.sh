#!/bin/bash
# Runs inside debian:trixie (see cu-headless.sh). Starts a D-Bus session,
# the AT-SPI bus and a headless labwc, then the end-to-end test.
# CU_E2E_GIMP=1: install GIMP and run the real-GIMP export test instead.
# CU_E2E_GTK3=1: also type into a GTK3 app (yad); open issue under headless.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends labwc wev zenity foot at-spi2-core dbus dbus-bin \
  fonts-dejavu-core xkb-data procps >/dev/null
useradd -m -u 1000 tester
gimp=${CU_E2E_GIMP:-0}
gtk3=${CU_E2E_GTK3:-0}
[ "$gtk3" = 1 ] && apt-get install -y -qq --no-install-recommends yad >/dev/null
run=TestComputerUseAgainstLabwc
if [ "$gimp" = 1 ]; then
  # Final review finding 1: real GIMP 3 export dialogs (gimp_test.go).
  apt-get install -y -qq --no-install-recommends gimp >/dev/null
  mkdir -p /home/tester/.config/GIMP/3.0
  # The Welcome window also opens on the first start of a release unless
  # the profile already knows it.
  ver=$(gimp --version 2>/dev/null | grep -o '[0-9][0-9.]*$' || true)
  printf '%s\n' '(show-welcome-dialog no)' '(show-tips no)' '(restore-session no)' \
    '(save-session-info no)' '(check-updates no)' \
    "(config-version \"$ver\")" "(last-known-release \"$ver\")" > /home/tester/.config/GIMP/3.0/gimprc
  chown -R tester /home/tester/.config
  run=TestGimpExportThroughDialogs
fi
printf 'export JARVIS_CU_GIMP=%s JARVIS_CU_GTK3=%s CU_RUN=%s\n' "$gimp" "$gtk3" "$run" > /home/tester/session.sh
cat >>/home/tester/session.sh <<'EOF'
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
JARVIS_CU_INTEGRATION=1 JARVIS_CU_BIN=/work/jarvis-cu \
  /work/cu-e2e.test -test.v -test.timeout 10m -test.run "^${CU_RUN}\$"
EOF
chown tester /home/tester/session.sh
su tester -c 'dbus-run-session -- bash /home/tester/session.sh'
