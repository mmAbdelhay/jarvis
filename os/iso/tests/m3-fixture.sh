# shellcheck shell=bash
# m3_fixture CHROOT — the Rafiq M3 pieces verify-m3.sh expects, for test chroots.
M3_PKGS="jarvis-settings jarvis-apps jarvis-wl jarvis-lock jarvis-idle jarvis-voice-models jarvis-voice-engines
  brightnessctl wireplumber wlsunset bluez power-profiles-daemon wlr-randr udisks2 xdg-utils mako-notifier exfatprogs"
# Linux uses a real ELF; macOS only exercises the ELF-magic image check.
m3_elf() {
  if [ -f /bin/true ]; then install -m0755 /bin/true "$1"; else
    printf '\177ELFfixture\n' > "$1"; chmod 0755 "$1"
  fi
}
m3_fixture() {
  local c=$1 p
  mkdir -p "$c/etc/xdg/labwc" "$c/usr/local/bin" "$c/usr/libexec/jarvis" "$c/usr/share/jarvis-idle/labwc" \
    "$c/usr/bin" "$c/etc/pam.d" "$c/usr/share/polkit-1/rules.d" "$c/usr/share/jarvis/voice" \
    "$c/usr/lib/jarvis/voice/bin" \
    "$c/etc/systemd/system/bluetooth.target.wants" "$c/var/lib/dpkg"
  printf '<keybind key="W-l"><action name="Execute" command="jarvis-lock" />\n<keybind key="W-space"><action name="Execute" command="/usr/libexec/jarvis/jarvis-session-key --voice" />\n' >> "$c/etc/xdg/labwc/rc.xml"
  printf 'systemctl --user import-environment WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP\nmako &\n. /usr/share/jarvis-idle/labwc/autostart\n' >> "$c/etc/xdg/labwc/autostart"
  printf '#!/bin/sh\nexec /usr/bin/labwc --merge-config "$@"\n' > "$c/usr/local/bin/labwc"
  m3_elf "$c/usr/libexec/jarvis/jarvis-idle"
  m3_elf "$c/usr/libexec/jarvis/jarvis-idle-loop"
  echo '/usr/libexec/jarvis/jarvis-idle-loop &' > "$c/usr/share/jarvis-idle/labwc/autostart"
  m3_elf "$c/usr/bin/jarvis-lock"
  printf 'auth optional pam_faildelay.so delay=2000000\n@include common-auth\n@include common-account\n' > "$c/etc/pam.d/jarvis-lock"
  echo 'polkit.addRule(function (action, subject) {});' > "$c/usr/share/polkit-1/rules.d/51-jarvis-settings.rules"
  echo '{"version":1,"stt":[],"tts":[]}' > "$c/usr/share/jarvis/voice/manifest.json"
  m3_elf "$c/usr/lib/jarvis/voice/bin/whisper-cli"
  m3_elf "$c/usr/lib/jarvis/voice/bin/piper"
  ln -sf /usr/lib/systemd/system/bluetooth.service "$c/etc/systemd/system/bluetooth.target.wants/bluetooth.service"
  for p in $M3_PKGS; do printf 'Package: %s\nStatus: install ok installed\n\n' "$p" >> "$c/var/lib/dpkg/status"; done
}
