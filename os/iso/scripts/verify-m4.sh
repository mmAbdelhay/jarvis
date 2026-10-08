#!/usr/bin/env bash
# verify-m4.sh CHROOT — Rafiq M4 pieces in the built image (M4 contracts
# §1-§5): the backup model in the Ollama store and writable by ollama, both
# sessions and the fallback wiring, Arabic fonts, locale and compiled
# translations, the recipes, and no jarvis-workspace by default. Lists every
# problem, then fails. Called by verify-chroot.sh.
set -euo pipefail
c=$1
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../../branding/lib/brand.sh
. "$here/../../branding/lib/brand.sh"
brand_load
problems=()
field() { # field PACKAGE FIELD — from the image's dpkg status
  awk -v p="$1" -v f="$2: " '$0 == "Package: " p {s = 1; next} s && /^$/ {exit}
    s && index($0, f) == 1 {print substr($0, length(f) + 1); exit}' "$c/var/lib/dpkg/status"
}
installed() { [ "$(field "$1" Status)" = "install ok installed" ]; }

for p in jarvis-backup-model jarvis-classic jarvis-session jarvis-fonts jarvis-i18n jarvis-recipes \
  pcmanfm-qt fonts-noto-core fonts-ibm-plex; do
  installed "$p" || problems+=("package $p is not installed")
done
if installed jarvis-workspace; then
  problems+=("jarvis-workspace is installed; it is optional and not in the default image (contracts §5)")
fi

# Sessions and the classic fallback (§2).
s=$c/usr/share/wayland-sessions
grep -qx 'Exec=/usr/libexec/jarvis/jarvis-session full' "$s/$DISTRO_ID.desktop" 2>/dev/null ||
  problems+=("$DISTRO_ID.desktop missing or not the full session")
grep -qx 'Exec=/usr/libexec/jarvis/jarvis-session classic' "$s/$DISTRO_ID-classic.desktop" 2>/dev/null ||
  problems+=("$DISTRO_ID-classic.desktop missing or not the classic session")
for f in jarvis-session jarvis-shell-guard jarvis-session-key; do
  [ -x "$c/usr/libexec/jarvis/$f" ] || problems+=("/usr/libexec/jarvis/$f missing")
done
[ -x "$c/usr/bin/jarvis-classic" ] || problems+=("/usr/bin/jarvis-classic missing")
grep -qx '. /usr/share/jarvis-session/labwc/autostart' "$c/etc/xdg/labwc/autostart" 2>/dev/null ||
  problems+=("labwc autostart does not start the shell through the fallback guard")
grep -q 'JARVIS_SHELL_BIN=/usr/libexec/jarvis/jarvis-shell-guard' "$c/usr/share/jarvis-session/labwc/autostart" 2>/dev/null ||
  problems+=("the jarvis-session autostart fragment does not use the guard")
grep -q 'command="/usr/libexec/jarvis/jarvis-session-key --focus"' "$c/etc/xdg/labwc/rc.xml" 2>/dev/null ||
  problems+=("Super does not go through jarvis-session-key (would start the full shell over classic)")

# Backup model (§1): the pinned files at Ollama's paths, directories owned by ollama.
if [[ "$(field jarvis-backup-model Version)" == *~stub* ]]; then
  echo "JARVIS-BUILD-WARNING: jarvis-backup-model is a stub; the image has no backup model" >&2
else
  while IFS= read -r line; do
    [ -n "$line" ] && problems+=("$line")
  done < <(python3 - "$c" "$here/../../models/backup-model.lock.json" <<'PY'
import json, sys
from pathlib import Path
c, lock = Path(sys.argv[1]), json.load(open(sys.argv[2]))
store = c / "var/lib/ollama/models"
name, ver = lock["ollamaTag"].rsplit(":", 1)
m = store / "manifests/registry.ollama.ai" / (name if "/" in name else f"library/{name}") / ver
if not m.is_file():
    print(f"backup model manifest /{m.relative_to(c)} missing")
for b in lock["blobs"]:
    f = store / "blobs" / b["digest"].replace(":", "-")
    if not f.is_file():
        print(f"backup model blob {f.name} missing")
    elif f.stat().st_size != b["size"]:
        print(f"backup model blob {f.name} is {f.stat().st_size} bytes, pinned {b['size']}")
PY
  )
  uid=$(awk -F: '$1 == "ollama" {print $3}' "$c/etc/passwd" 2>/dev/null)
  if [ -z "$uid" ]; then
    problems+=("user ollama missing")
  else
    for d in var/lib/ollama/models var/lib/ollama/models/blobs var/lib/ollama/models/manifests; do
      [ "$(stat -c %u "$c/$d" 2>/dev/null)" = "$uid" ] ||
        problems+=("/$d is not owned by ollama (installer and first-boot model pulls would fail)")
    done
  fi
fi

# Arabic: fonts, translations, locale (§3).
[ -L "$c/etc/fonts/conf.d/65-jarvis-arabic.conf" ] || problems+=("Arabic fontconfig rule is not enabled")
for f in NotoNaskhArabic NotoKufiArabic NotoSansArabic; do
  find "$c/usr/share/fonts" -name "$f-*" -print -quit 2>/dev/null | grep -q . || problems+=("font $f missing (fonts-noto-core)")
done
for comp in shell installer greeter lock classic; do
  for lang in en ar; do
    q=$c/usr/share/jarvis/i18n/jarvis-${comp}_${lang}.qm
    if [ ! -s "$q" ] || [ "$(head -c 16 "$q" | od -An -tx1 | tr -d ' \n')" != 3cb86418caef9c95cd211cbf60a1bddd ]; then
      problems+=("/usr/share/jarvis/i18n/jarvis-${comp}_${lang}.qm missing or not a compiled translation")
    fi
  done
done
grep -qx 'ar_EG.UTF-8 UTF-8' "$c/etc/locale.gen" 2>/dev/null || problems+=("ar_EG.UTF-8 is not enabled in /etc/locale.gen")
[ -s "$c/usr/lib/locale/locale-archive" ] || problems+=("no compiled locales (/usr/lib/locale/locale-archive)")

# Recipes (§4, §5).
for r in python-dev node-dev docker go-dev media-basics office-basics jarvis-workspace; do
  [ -f "$c/usr/share/jarvis/recipes/$r.json" ] || problems+=("recipe $r missing")
done

if [ ${#problems[@]} -gt 0 ]; then
  printf 'verify-m4: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "verify-m4: ok"
