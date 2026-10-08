#!/usr/bin/env bash
# jarvis-i18n (M4 contracts §3): every component's en/ar .ts compiled to
# /usr/share/jarvis/i18n/jarvis-<component>_<lang>.qm, only after the gate
# passes. Needs lrelease (TRIXIE_PACKAGES="qt6-l10n-tools").
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
if ! command -v "${LRELEASE:-lrelease}" >/dev/null && ! command -v lrelease6 >/dev/null && [ ! -x /usr/lib/qt6/bin/lrelease ]; then
  echo 'SKIP test-i18n-pkg.sh: needs lrelease (TRIXIE_PACKAGES="qt6-l10n-tools")' >&2
  exit 1
fi
write_ts() { # write_ts FILE LANG TRANSLATION
  cat > "$1" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE TS>
<TS version="2.1" language="$2">
<context><name>Main</name><message><source>Send</source><translation>$3</translation></message></context>
</TS>
EOF
}
comps="shell installer greeter lock classic"
for c in $comps; do
  mkdir -p "$tmp/os/$c/i18n"
  write_ts "$tmp/os/$c/i18n/en.ts" en Send
  write_ts "$tmp/os/$c/i18n/ar.ts" ar 'إرسال'
done
I18N_ROOT=$tmp/os "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-i18n >/dev/null
deb=$tmp/out/jarvis-i18n_${OS_VERSION}_all.deb
check "Architecture all" test "$(deb_field "$deb" Architecture)" = all
for c in $comps; do
  for l in en ar; do
    f=usr/share/jarvis/i18n/jarvis-${c}_${l}.qm
    magic=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO "./$f" 2>/dev/null | head -c 16 | od -An -tx1 | tr -d ' \n')
    check "$f is a compiled Qt translation" test "$magic" = 3cb86418caef9c95cd211cbf60a1bddd
  done
done
check "the Arabic text is in jarvis-lock_ar.qm (UTF-16)" python3 - "$deb" <<'PY'
import subprocess, sys
data = subprocess.run(["dpkg-deb", "--fsys-tarfile", sys.argv[1]], capture_output=True, check=True).stdout
qm = subprocess.run(["tar", "-xO", "./usr/share/jarvis/i18n/jarvis-lock_ar.qm"], input=data, capture_output=True, check=True).stdout
assert "إرسال".encode("utf-16-be") in qm
PY

# The gate runs first: an unfinished Arabic entry fails the build.
sed -i 's#<translation>إرسال</translation>#<translation type="unfinished"></translation>#' "$tmp/os/lock/i18n/ar.ts"
err=$(I18N_ROOT=$tmp/os "$PACKAGING_DIR/build.sh" --out "$tmp/bad" jarvis-i18n 2>&1 || true)
check "an unfinished translation fails the build" test ! -e "$tmp/bad/jarvis-i18n_${OS_VERSION}_all.deb"
check "the error names the component and language" grep -q 'lock: ar: ' <<<"$err"

check "jarvis-ui pulls in the translations" grep -q '^Depends: jarvis-i18n (= @VERSION@)' "$PACKAGING_DIR/jarvis-ui/control.in"

# One owner per file: other stages drop what they install under /usr/share/jarvis/i18n.
# shellcheck source=../lib/stage-cmake.sh
. "$PACKAGING_DIR/lib/stage-cmake.sh"
mkdir -p "$tmp/st/usr/share/jarvis/i18n" "$tmp/st/usr/share/jarvis/models"
: > "$tmp/st/usr/share/jarvis/i18n/ar.qm"
drop_shared_translations "$tmp/st" 2>/dev/null
check "a component's own .qm copy is dropped" test ! -e "$tmp/st/usr/share/jarvis/i18n"
check "other /usr/share/jarvis content is kept" test -d "$tmp/st/usr/share/jarvis/models"
check "jarvis-shell's stage drops them too" grep -q 'drop_shared_translations "\$stage"' "$PACKAGING_DIR/jarvis-shell/stage.sh"
finish
