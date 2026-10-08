#!/usr/bin/env bash
# Inside debian:trixie as root: headless labwc sessions for user "tester" with
# the ISO's labwc files, the real jarvis-session package and jarvis-shell's
# real relaunch loop. jarvis-shell crashes or stays up as /tmp/shell-mode
# says; jarvis-classic stays up. Every call is recorded in /out/calls.
set -euo pipefail
inc=/src/os/iso/config/includes.chroot_after_packages
apt-get update -qq
apt-get install -y -qq --no-install-recommends labwc wtype procps passwd libgl1-mesa-dri \
  /debs/jarvis-session_*.deb >/dev/null
useradd -m -s /bin/bash tester
install -d -m0755 /etc/xdg/labwc /usr/share/jarvis-shell
cp "$inc/etc/xdg/labwc/rc.xml" "$inc/etc/xdg/labwc/environment" /etc/xdg/labwc/
# The real autostart minus what this container does not have.
grep -v -e 'jarvis-idle' -e 'jarvis-installer' -e '^mako &' "$inc/etc/xdg/labwc/autostart" > /etc/xdg/labwc/autostart
# The classic session's config directory (contracts §6.14): the classic
# desktop's own autostart and the ISO's keybinds (Super and Super+Space go
# through jarvis-session-key, which opens the docked chat in this session).
install -d -m0755 /etc/xdg/labwc-classic
cp /src/os/classic/data/labwc/autostart /etc/xdg/labwc-classic/autostart
cp "$inc/etc/xdg/labwc/rc.xml" "$inc/etc/xdg/labwc/environment" /etc/xdg/labwc-classic/
install -m0755 "$inc/usr/local/bin/labwc" /usr/local/bin/labwc
install -m0755 /src/os/shell/data/jarvis-shell-loop /usr/share/jarvis-shell/jarvis-shell-loop
cat > /usr/local/bin/jarvis-shell <<'EOF'
#!/bin/sh
echo "shell:$*" >> /out/calls
[ -z "$*" ] || exit 0
[ "$(cat /tmp/shell-mode)" = crash ] && exit 1
exec sleep infinity
EOF
cat > /usr/bin/jarvis-classic <<'EOF'
#!/bin/sh
echo "classic:$*" >> /out/calls
[ -z "$*" ] || exit 0
exec sleep infinity
EOF
chmod 0755 /usr/local/bin/jarvis-shell /usr/bin/jarvis-classic
: > /out/calls; chmod 0666 /out/calls
echo crash > /tmp/shell-mode; chmod 0644 /tmp/shell-mode
rt=/tmp/xdg-tester
install -d -m0700 -o tester -g tester "$rt"
marker=$rt/jarvis/classic-fallback
as_tester() { runuser -u tester -- env HOME=/home/tester XDG_RUNTIME_DIR="$rt" "$@"; }
failures=0
check() { local name=$1; shift; if "$@"; then echo "ok   $name" | tee -a /out/results.txt; else echo "FAIL $name" | tee -a /out/results.txt; failures=$((failures + 1)); fi; }
wait_for() { local secs=$1 _; shift; for _ in $(seq "$secs"); do "$@" && return 0; sleep 1; done; return 1; }
calls() { grep -c -x -- "$1" /out/calls || true; }
socket_up() { [ -S "$rt/wayland-0" ]; }
labwc_gone() { ! pgrep -u tester -x labwc >/dev/null; }
marker_written() { [ -e "$marker" ]; }
classic_started() { [ "$(calls 'classic:')" -ge 1 ]; }
shell_started() { [ "$(calls 'shell:')" -ge 1 ]; }
chat_opened() { [ "$(calls 'classic:--chat')" -eq 1 ]; }
focused() { [ "$(calls 'shell:--focus')" -eq 1 ]; }
key() { as_tester env WAYLAND_DISPLAY=wayland-0 wtype "$@"; }
session() { # session MODE — labwc through the real launcher
  as_tester env WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1 \
    LABWC_KEYBOARD_FILE=/nonexistent /usr/libexec/jarvis/jarvis-session "$1" >> /out/labwc.log 2>&1 &
  wait_for 30 socket_up
}
end_session() {
  pkill -u tester -x labwc || true
  wait_for 15 labwc_gone || true
  pkill -u tester -x sleep || true
  rm -f "$rt"/wayland-0*
  cp /out/calls "/out/calls.$1"; : > /out/calls
}

# 1. Full session, the shell keeps crashing: three tries, then classic.
check "full session starts headless" session full
check "a crashing shell ends in the fallback marker" wait_for 40 marker_written
check "the classic desktop takes over" wait_for 20 classic_started
check "the shell was tried exactly three times" test "$(calls 'shell:')" -eq 3
sleep 5
check "the classic desktop keeps running (not relaunched)" test "$(calls 'classic:')" -eq 1
key -k Super_L
check "after the fallback, Super opens the docked chat" wait_for 10 chat_opened
check "Super never starts a full shell over the classic desktop" test "$(calls 'shell:--focus')" -eq 0
end_session fallback

# 2. The classic session from the login menu; a stale marker from before.
echo ok > /tmp/shell-mode
install -d -m0700 -o tester -g tester "$rt/jarvis"
echo reason=shell-failed > "$marker"; chown tester:tester "$marker"
check "classic session starts headless" session classic
check "a marker from the previous login is cleared" wait_for 10 sh -c "[ ! -e '$marker' ]"
check "the classic session runs the classic desktop" wait_for 20 classic_started
sleep 5
check "classic session never starts jarvis-shell" test "$(calls 'shell:')" -eq 0
key -M logo -k space -m logo
check "Super+Space opens the docked chat in the classic session" wait_for 10 chat_opened
end_session classic

# 3. Full session with a healthy shell.
check "full session with a healthy shell starts" session full
check "the shell starts" wait_for 20 shell_started
sleep 8
check "no fallback while the shell runs" test ! -e "$marker"
key -k Super_L
check "Super reaches jarvis-shell --focus" wait_for 10 focused
end_session healthy

if [ "$failures" -gt 0 ]; then
  echo "--- labwc.log (tail) ---"; tail -n 60 /out/labwc.log
  echo "$failures failure(s)"; exit 1
fi
echo "all passed"
