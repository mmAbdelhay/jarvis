#!/usr/bin/env bash
# verify-m3.sh CHROOT — Rafiq M3 pieces in the built image (M3 contracts §1,
# §3, §4): packages, lock binary and PAM, keybinds, session autostart, polkit,
# voice. Lists every problem, then fails. Called by verify-chroot.sh.
set -euo pipefail
c=$1
problems=()
installed() {
  [ -f "$c/var/lib/dpkg/status" ] || return 1
  awk -v p="$1" 'BEGIN {RS=""; FS="\n"}
    {package=""; status=""; for (i=1;i<=NF;i++) {
      if ($i ~ /^Package: /) package=substr($i,10)
      if ($i ~ /^Status: /) status=substr($i,9)
    } if (package == p && status == "install ok installed") found=1}
    END {exit !found}' "$c/var/lib/dpkg/status"
}
for p in jarvis-settings jarvis-apps jarvis-wl jarvis-lock jarvis-idle jarvis-voice-models jarvis-voice-engines \
  brightnessctl wireplumber wlsunset bluez power-profiles-daemon wlr-randr udisks2 xdg-utils mako-notifier exfatprogs; do
  installed "$p" || problems+=("package $p is not installed")
done
rc=$c/etc/xdg/labwc/rc.xml
binding() {
  [ -f "$rc" ] || return 1
  awk -v key="$1" -v command="$2" '
    /<keybind[ >]/ {active = index($0, "key=\"" key "\"") > 0}
    active && index($0, "command=\"" command "\"") {found=1}
    /<\/keybind>/ {active=0}
    END {exit !found}' "$rc"
}
binding W-l 'jarvis-lock' || problems+=("labwc rc.xml lacks the Super+L -> jarvis-lock bind")
binding W-space '/usr/libexec/jarvis/jarvis-session-key --voice' || problems+=("labwc rc.xml lacks the Super+Space push-to-talk bind")
as=$c/etc/xdg/labwc/autostart
grep -qx '. /usr/share/jarvis-idle/labwc/autostart' "$as" 2>/dev/null || problems+=("labwc autostart does not start the idle lock")
grep -q 'import-environment WAYLAND_DISPLAY DISPLAY XDG_CURRENT_DESKTOP' "$as" 2>/dev/null || problems+=("labwc autostart does not give WAYLAND_DISPLAY to the user manager")
grep -qx 'mako &' "$as" 2>/dev/null || problems+=("labwc autostart does not start mako")
grep -q -- '--merge-config' "$c/usr/local/bin/labwc" 2>/dev/null || problems+=("labwc wrapper does not merge user config over the system's")
[ -x "$c/usr/libexec/jarvis/jarvis-idle" ] || problems+=("jarvis-idle missing")
[ -x "$c/usr/libexec/jarvis/jarvis-idle-loop" ] || problems+=("jarvis-idle-loop missing")
[ -f "$c/usr/share/jarvis-idle/labwc/autostart" ] || problems+=("jarvis-idle autostart fragment missing")
lock=$c/usr/bin/jarvis-lock
if [ -L "$lock" ] || [ ! -f "$lock" ]; then
  problems+=("/usr/bin/jarvis-lock is missing or a symlink (jarvisd checks /proc/<pid>/exe)")
elif [ "$(head -c 4 "$lock" | od -An -tx1 | tr -d ' \n')" != 7f454c46 ]; then
  problems+=("/usr/bin/jarvis-lock is not an ELF binary (jarvisd checks /proc/<pid>/exe)")
elif [ ! -x "$lock" ]; then
  problems+=("/usr/bin/jarvis-lock is not executable")
elif [ -u "$lock" ] || [ -g "$lock" ]; then
  problems+=("/usr/bin/jarvis-lock must not be setuid or setgid")
fi
pam=$c/etc/pam.d/jarvis-lock
if [ ! -f "$pam" ]; then
  problems+=("PAM service jarvis-lock missing")
else
  grep -qx '@include common-auth' "$pam" || problems+=("jarvis-lock PAM does not use common-auth")
  if grep -q 'pam_permit' "$pam"; then problems+=("jarvis-lock PAM contains pam_permit"); fi
fi
[ -f "$c/usr/share/polkit-1/rules.d/51-jarvis-settings.rules" ] || problems+=("polkit rule 51-jarvis-settings.rules missing")
if grep -qs 'os.jarvis.helper.admin' "$c/usr/share/polkit-1/rules.d/51-jarvis-settings.rules"; then
  problems+=("the settings polkit rule names the password-tier admin action")
fi
[ -s "$c/usr/share/jarvis/voice/manifest.json" ] || problems+=("voice model manifest missing")
[ -x "$c/usr/lib/jarvis/voice/bin/whisper-cli" ] || problems+=("whisper-cli missing")
[ -x "$c/usr/lib/jarvis/voice/bin/piper" ] || problems+=("piper missing")
compgen -G "$c/etc/systemd/system/*.wants/bluetooth.service" >/dev/null || problems+=("bluetooth.service is not enabled")
if [ ${#problems[@]} -gt 0 ]; then
  printf 'verify-m3: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "verify-m3: ok"
