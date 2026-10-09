#!/usr/bin/env bash
# Inside debian:trixie as root (os/iso/cu/run.sh): the real Jarvis packages,
# GIMP and a headless labwc with the ISO's config; then session.sh as user
# "tester" inside a D-Bus session (AT-SPI and jarvisd need one). No systemd
# runs here, so session.sh starts jarvis-cu and jarvisd the way their units do.
set -euo pipefail
inc=/src/os/iso/config/includes.chroot_after_packages
# jarvis-ui depends on fonts-ibm-plex, which trixie has in contrib only.
sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources
apt-get update -qq
debs=()
for p in jarvisd jarvis-pkg jarvis-diag jarvis-helper jarvis-cu jarvis-i18n jarvis-ui jarvis-lock jarvis-session; do
  debs+=(/debs/"$p"_*.deb)
done
if ! apt-get install -y -qq --no-install-recommends labwc foot wtype wlr-randr wayland-utils procps iproute2 \
  dbus dbus-user-session at-spi2-core gimp libgl1-mesa-dri fonts-inter passwd libpam-modules-bin libpam-runtime \
  ca-certificates "${debs[@]}" > /out/apt.log 2>&1; then
  tail -n 40 /out/apt.log >&2
  exit 1
fi
useradd -m -s /bin/bash tester
echo 'tester:correct horse' | chpasswd
install -d -m0755 /etc/xdg/labwc
cp "$inc/etc/xdg/labwc/rc.xml" "$inc/etc/xdg/labwc/environment" /etc/xdg/labwc/
# The real autostart minus what needs systemd, the shell or the installer.
grep -v -e 'jarvis-session/labwc/autostart' -e 'jarvis-cu/labwc/autostart' -e 'jarvis-idle' -e 'jarvis-installer' \
  -e '^mako' "$inc/etc/xdg/labwc/autostart" > /etc/xdg/labwc/autostart
install -m0755 "$inc/usr/local/bin/labwc" /usr/local/bin/labwc
chown tester /out
install -d -m0700 -o tester -g tester /tmp/xdg-tester
exec runuser -u tester -- env HOME=/home/tester XDG_RUNTIME_DIR=/tmp/xdg-tester LANG=C.UTF-8 \
  dbus-run-session -- bash /src/os/iso/cu/session.sh
