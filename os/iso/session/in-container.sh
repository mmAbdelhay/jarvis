#!/usr/bin/env bash
# Inside debian:trixie, as root. A headless labwc session for user "tester"
# with the ISO's labwc files and the real jarvis-lock/jarvis-idle packages;
# wtype is the keyboard. Results in /out.
set -euo pipefail
inc=/src/os/iso/config/includes.chroot_after_packages
apt-get update -qq
apt-get install -y -qq --no-install-recommends labwc wtype procps passwd libpam-modules-bin libpam-runtime \
  libgl1-mesa-dri fonts-inter /debs/jarvis-ui_*.deb /debs/jarvis-lock_*.deb /debs/jarvis-idle_*.deb /debs/jarvis-session_*.deb >/dev/null

useradd -m -s /bin/bash tester
echo 'tester:correct horse' | chpasswd
install -d -m0755 /etc/xdg/labwc
cp "$inc/etc/xdg/labwc/rc.xml" "$inc/etc/xdg/labwc/environment" /etc/xdg/labwc/
# The real autostart minus what this container does not have (shell, mako,
# installer). The jarvis-idle fragment is the one the .deb installed.
grep -v -e 'jarvis-shell/labwc/autostart' -e 'jarvis-session/labwc/autostart' -e 'jarvis-installer' -e '^mako' "$inc/etc/xdg/labwc/autostart" > /etc/xdg/labwc/autostart
install -m0755 "$inc/usr/local/bin/labwc" /usr/local/bin/labwc
# jarvis-shell stand-in: records how the keybinds called it.
printf '#!/bin/sh\necho "$*" >> /out/shell-calls\n' > /usr/local/bin/jarvis-shell
chmod 0755 /usr/local/bin/jarvis-shell
: > /out/shell-calls; chmod 0666 /out/shell-calls
install -d -m0755 -o tester -g tester /home/tester/.config/jarvis
printf 'os:\n  idle:\n    lockAfterMinutes: 1\n' > /home/tester/.config/jarvis/jarvis.yaml
chown tester:tester /home/tester/.config/jarvis/jarvis.yaml
rt=/tmp/xdg-tester
install -d -m0700 -o tester -g tester "$rt"
as_tester() { runuser -u tester -- env HOME=/home/tester XDG_RUNTIME_DIR="$rt" "$@"; }

as_tester env WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1 \
  LABWC_KEYBOARD_FILE=/nonexistent QT_QUICK_BACKEND=software /usr/local/bin/labwc > /out/labwc.log 2>&1 &
failures=0
check() { local name=$1; shift; if "$@"; then echo "ok   $name" | tee -a /out/results.txt; else echo "FAIL $name" | tee -a /out/results.txt; failures=$((failures + 1)); fi; }
wait_for() { local secs=$1 _; shift; for _ in $(seq "$secs"); do "$@" && return 0; sleep 1; done; return 1; }
socket_up() { [ -S "$rt/wayland-0" ]; }
locked() { pgrep -u tester -x jarvis-lock >/dev/null; }
unlocked() { ! locked; }
key() { as_tester env WAYLAND_DISPLAY=wayland-0 wtype "$@"; }
idle_restarted() { local p; p=$(pgrep -u tester -x jarvis-idle | head -n1); [ -n "$p" ] && [ "$p" != "$old_idle" ]; }
focus_count() { grep -cx -- '--focus' /out/shell-calls || true; }

check "labwc starts headless with the ISO config (--merge-config accepted)" wait_for 30 socket_up
check "jarvis-idle runs in the session" wait_for 15 pgrep -u tester -x jarvis-idle

key -k Super_L
check "Super alone focuses the shell" wait_for 5 grep -qx -- '--focus' /out/shell-calls
key -M logo -k space -m logo
check "Super+Space runs push-to-talk" wait_for 5 grep -qx -- '--voice' /out/shell-calls
key -M logo -k l -m logo
check "Super+L locks" wait_for 10 locked
check "chords never fire the Super-alone bind" test "$(focus_count)" -eq 1
sleep 3
key 'wrong password'; key -k Return
sleep 4
check "a wrong password keeps the session locked" locked
key 'correct horse'; key -k Return
check "the right password unlocks" wait_for 10 unlocked

check "idle locks after lockAfterMinutes" wait_for 100 locked
sleep 3
key 'correct horse'; key -k Return
check "unlocks after the idle lock" wait_for 10 unlocked

old_idle=$(pgrep -u tester -x jarvis-idle | head -n1)
kill "$old_idle"
check "the loop restarts jarvis-idle" wait_for 10 idle_restarted

if [ "$failures" -gt 0 ]; then
  echo "--- labwc.log (tail) ---"; tail -n 60 /out/labwc.log
  echo "$failures failure(s)"; exit 1
fi
echo "all passed"
