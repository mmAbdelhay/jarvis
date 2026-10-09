#!/usr/bin/env bash
# Stage jarvis-i18n (M4 contracts §3): every component's Qt translations
# (os/<component>/i18n/{en,ar}.ts) compiled to
# /usr/share/jarvis/i18n/jarvis-<component>_<lang>.qm, after the i18n gate
# passed (no missing key, nothing unfinished).
set -euo pipefail
stage=$1
root=${I18N_ROOT:-$REPO_ROOT/os}
lrelease=${LRELEASE:-}
if [ -z "$lrelease" ]; then
  for c in /usr/lib/qt6/bin/lrelease lrelease6 lrelease; do
    if command -v "$c" >/dev/null; then lrelease=$(command -v "$c"); break; fi
  done
fi
[ -n "$lrelease" ] || { echo "jarvis-i18n: no lrelease (apt install qt6-l10n-tools)" >&2; exit 1; }
python3 "$REPO_ROOT/os/packaging/lib/i18n_gate.py" --root "$root"
out=$stage/usr/share/jarvis/i18n
mkdir -p "$out"
n=0
for ts in "$root"/*/i18n/*.ts; do
  [ -f "$ts" ] || continue
  comp=$(basename "$(dirname "$(dirname "$ts")")")
  lang=$(basename "$ts" .ts)
  "$lrelease" -silent "$ts" -qm "$out/jarvis-${comp}_${lang}.qm"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "jarvis-i18n: no .ts files under $root/*/i18n" >&2; exit 1; }
chmod 0644 "$out"/*.qm
