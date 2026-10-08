#!/usr/bin/env bash
# verify-m4.sh catches each missing or unsafe M4 piece (Review Focus 1, 3, 5),
# and the stub packages carry the real session scripts. Linux (dpkg-deb).
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/m4-fixture.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
v=$ISO_DIR/scripts/verify-m4.sh
c=$tmp/c
fresh() { rm -rf "$c"; m4_fixture "$c"; }
caught() { ! "$v" "$c" >/dev/null 2>&1; }
blob() { find "$c/var/lib/ollama/models/blobs" -type f | sort | tail -n1; }
fresh; check "complete M4 chroot verifies" "$v" "$c"
fresh; printf 'Package: jarvis-workspace\nStatus: install ok installed\nVersion: 1\n\n' >> "$c/var/lib/dpkg/status"
check "jarvis-workspace in the default image is caught (contracts §5)" caught
fresh; rm "$c/usr/share/wayland-sessions/rafiq-classic.desktop"; check "missing classic session is caught" caught
fresh; rm "$c/usr/libexec/jarvis/jarvis-shell-guard"; check "missing fallback guard is caught" caught
fresh; sed -i 's#jarvis-session/labwc#jarvis-shell/labwc#' "$c/etc/xdg/labwc/autostart"; check "shell started without the guard is caught" caught
fresh; sed -i 's#/usr/libexec/jarvis/jarvis-session-key --focus#jarvis-shell --focus#' "$c/etc/xdg/labwc/rc.xml"; check "Super straight to jarvis-shell is caught" caught
fresh; rm "$(blob)"; check "missing backup-model blob is caught" caught
fresh; truncate -s 1 "$(blob)"; check "a blob of the wrong size is caught" caught
fresh; sed -i 's/^ollama:x:[0-9]*:/ollama:x:4242:/' "$c/etc/passwd"; check "a store not owned by ollama is caught" caught
fresh; rm -rf "$c/var/lib/ollama/models"; sed -i 's/^Version: 0.4.0~test$/Version: 0.0.0~stub1/' "$c/var/lib/dpkg/status"
check "a stub backup model only warns" bash -c "'$v' '$c' 2>&1 | grep -q 'JARVIS-BUILD-WARNING: .*stub'"
fresh; rm "$c/usr/share/jarvis/i18n/jarvis-lock_ar.qm"; check "a missing Arabic translation is caught" caught
fresh; echo text > "$c/usr/share/jarvis/i18n/jarvis-shell_ar.qm"; check "a .qm that is not compiled is caught" caught
fresh; rm "$c"/usr/share/fonts/truetype/noto/NotoKufiArabic-*; check "missing Noto Kufi Arabic is caught" caught
fresh; rm "$c/etc/fonts/conf.d/65-jarvis-arabic.conf"; check "Arabic font rule not enabled is caught" caught
fresh; rm "$c/usr/share/jarvis/recipes/docker.json"; check "a missing seed recipe is caught" caught
fresh; sed -i '/ar_EG/d' "$c/etc/locale.gen"; check "no Arabic locale is caught" caught
fresh; sed -i '/^Package: pcmanfm-qt$/,+2d' "$c/var/lib/dpkg/status"; check "missing pcmanfm-qt is caught" caught

if command -v dpkg-deb >/dev/null; then
  "$ISO_DIR/dev/stub-debs.sh" "$tmp/stubs" >/dev/null
  for p in jarvis-backup-model jarvis-classic jarvis-session jarvis-fonts jarvis-i18n jarvis-recipes; do
    check "stub $p built" test -f "$tmp/stubs/${p}_0.0.0~stub1_amd64.deb"
  done
  check "stub session ships the real guard" cmp -s "$REPO_ROOT/os/packaging/jarvis-session/jarvis-shell-guard" \
    <(dpkg-deb --fsys-tarfile "$tmp/stubs/jarvis-session_0.0.0~stub1_amd64.deb" | tar -xO ./usr/libexec/jarvis/jarvis-shell-guard)
  check "stub backup model keeps the real postinst" cmp -s "$REPO_ROOT/os/packaging/jarvis-backup-model/postinst" \
    <(dpkg-deb --ctrl-tarfile "$tmp/stubs/jarvis-backup-model_0.0.0~stub1_amd64.deb" | tar -xO ./postinst)
else
  fail "stub debs: dpkg-deb missing (run through os/packaging/dev/trixie.sh)"
fi
finish
