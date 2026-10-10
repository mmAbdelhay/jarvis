#!/usr/bin/env bash
# verify-v11.sh CHROOT — Rafiq v1.1 computer-use pieces in the built image
# (contracts §1, §3), plus the built-in jarvis-files M3 left unpackaged: the helper and its network-less user unit, started only
# from the full session's autostart and stopped by the classic fallback, the
# AT-SPI bus and toolkit switches for password-field detection, and the
# catalog's vision flags. Lists every problem, then fails. Called by
# verify-chroot.sh.
set -euo pipefail
c=$1
problems=()
field() { # field PACKAGE FIELD — from the image's dpkg status
  [ -r "$c/var/lib/dpkg/status" ] || return 0
  awk -v p="$1" -v f="$2: " '$0 == "Package: " p {s = 1; next} s && /^$/ {exit}
    s && index($0, f) == 1 {print substr($0, length(f) + 1); exit}' "$c/var/lib/dpkg/status"
}
installed() { [ "$(field "$1" Status)" = "install ok installed" ]; }

for p in jarvis-cu jarvis-files at-spi2-core xdg-user-dirs; do installed "$p" || problems+=("package $p is not installed"); done
# The built-in jarvis-files (M3 contracts §1): jarvisd starts it from here and
# the files tools (move, copy, trash, restore) are missing without it.
files=$c/usr/lib/jarvis/mcp/jarvis-files
if [ -L "$files" ] || [ ! -f "$files" ] || [ ! -x "$files" ]; then
  problems+=("/usr/lib/jarvis/mcp/jarvis-files is missing or not an executable file (M3 contracts §1)")
elif [ "$(head -c 4 "$files" | od -An -tx1 | tr -d ' \n')" != 7f454c46 ]; then
  problems+=("/usr/lib/jarvis/mcp/jarvis-files is not an ELF binary")
fi
[ -x "$c/usr/libexec/jarvis/jarvis-cu" ] || problems+=("/usr/libexec/jarvis/jarvis-cu missing (contracts §1)")
unit=$c/usr/lib/systemd/user/jarvis-cu.service
if [ -f "$unit" ]; then
  awk -F= '
    /^RestrictAddressFamilies=/ {
      seen++; n = split($2, families, " "); unix = 0
      for (i = 1; i <= n; i++) {
        if (families[i] == "AF_UNIX") unix = 1
        else unsafe = 1
      }
      if (!unix) unsafe = 1
    }
    END {exit !(seen == 1 && !unsafe)}' "$unit" ||
    problems+=("jarvis-cu.service may open network sockets (screenshots must stay on the machine)")
else
  problems+=("user unit /usr/lib/systemd/user/jarvis-cu.service missing")
fi
for d in etc/systemd/user usr/lib/systemd/user; do
  if compgen -G "$c/$d/*.wants/jarvis-cu.service" >/dev/null; then
    problems+=("jarvis-cu.service is enabled under /$d; only the full session's autostart may start it")
  fi
done
line='if [ -r /usr/share/jarvis-cu/labwc/autostart ]; then . /usr/share/jarvis-cu/labwc/autostart; fi'
grep -qxF "$line" "$c/etc/xdg/labwc/autostart" 2>/dev/null || problems+=("labwc autostart does not start jarvis-cu")
awk -v helper="$line" '
  /^[[:space:]]*systemctl --user import-environment / && /WAYLAND_DISPLAY/ {imported = 1}
  $0 == helper {seen = 1; if (!imported) unsafe = 1}
  END {exit !(seen && !unsafe)}' "$c/etc/xdg/labwc/autostart" 2>/dev/null ||
  problems+=("labwc must import WAYLAND_DISPLAY before starting jarvis-cu (contracts §4.6)")
[ -f "$c/usr/share/jarvis-cu/labwc/autostart" ] || problems+=("jarvis-cu's autostart fragment is missing")
if awk '
  /^[[:space:]]*#/ {next}
  /jarvis-cu/ && !/^[[:space:]]*systemctl --user stop jarvis-cu[.]service([[:space:]]|$)/ {found = 1}
  END {exit !found}' "$c/etc/xdg/labwc-classic/autostart" 2>/dev/null; then
  problems+=("the classic session starts jarvis-cu, but it has no overlay to show or stop computer use")
fi
grep -q 'jarvis-cu.service' "$c/usr/libexec/jarvis/jarvis-shell-guard" 2>/dev/null ||
  problems+=("the classic fallback does not stop jarvis-cu")
# Final review finding 4: Super+Esc is the keyboard Take over (the model may
# never press Super); it must reach jarvis-shell --cu-stop.
awk '
  /<keybind key="W-Escape"/ {inbind = 1}
  inbind && /command="\/usr\/libexec\/jarvis\/jarvis-session-key --cu-stop"/ {ok = 1}
  /<\/keybind>/ {inbind = 0}
  END {exit !ok}' "$c/etc/xdg/labwc/rc.xml" 2>/dev/null ||
  problems+=("labwc rc.xml lacks the Super+Esc -> jarvis-session-key --cu-stop take-over bind")
grep -q -- '--cu-stop' "$c/usr/libexec/jarvis/jarvis-session-key" 2>/dev/null ||
  problems+=("jarvis-session-key cannot stop computer use (Super+Esc)")
for a in labwc labwc-classic; do
  grep -qE '^[[:space:]]*xdg-user-dirs-update([[:space:]]|$)' "$c/etc/xdg/$a/autostart" 2>/dev/null ||
    problems+=("/etc/xdg/$a/autostart does not run xdg-user-dirs-update (no Pictures or Documents folder)")
done
for v in GNOME_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1; do
  grep -qx "$v" "$c/etc/xdg/labwc/environment" 2>/dev/null ||
    problems+=("labwc environment lacks $v (password fields would be invisible to jarvis-cu)")
done
[ -f "$c/usr/share/dbus-1/services/org.a11y.Bus.service" ] ||
  problems+=("the AT-SPI bus is not D-Bus activatable (org.a11y.Bus.service missing)")
while IFS= read -r l; do
  [ -n "$l" ] && problems+=("$l")
done < <(python3 - "$c/usr/share/jarvis/models/catalog.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as source:
        models = json.load(source)["models"]
    if not isinstance(models, list) or not all(isinstance(m, dict) for m in models):
        raise ValueError("models must be a list of objects")
except (OSError, ValueError, KeyError, TypeError) as error:
    print(f"model catalog unreadable: {error}")
    sys.exit(0)
missing = [m.get("id") for m in models if not isinstance(m.get("vision"), bool)]
if missing:
    print(f"catalog models without a vision flag: {missing} (v1.1 contracts §3)")
if sum(m.get("vision") is True for m in models) > 1:
    print("the catalog lists more than one local vision model (v1.1 contracts §3)")
PY
)

if [ ${#problems[@]} -gt 0 ]; then
  printf 'verify-v11: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "verify-v11: ok"
