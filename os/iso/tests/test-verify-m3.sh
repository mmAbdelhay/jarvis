#!/usr/bin/env bash
# verify-m3.sh catches each missing or unsafe M3 piece (Review Focus 1, 2, 5),
# and the stub packages carry the real pieces. Linux (ELF /bin/true, dpkg-deb).
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/m3-fixture.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
v=$ISO_DIR/scripts/verify-m3.sh
c=$tmp/c
fresh() { rm -rf "$c"; m3_fixture "$c"; }
caught() { ! "$v" "$c" >/dev/null 2>&1; }
fresh; check "complete M3 chroot verifies" "$v" "$c"
fresh; printf '#!/bin/sh\nexec /usr/libexec/real "$@"\n' > "$c/usr/bin/jarvis-lock"; check "a script jarvis-lock is caught" caught
fresh; rm "$c/usr/bin/jarvis-lock"; ln -s /bin/true "$c/usr/bin/jarvis-lock"; check "a symlinked jarvis-lock is caught" caught
if [ "$(uname -s)" = Linux ]; then fresh; chmod u+s "$c/usr/bin/jarvis-lock"; check "a setuid jarvis-lock is caught" caught; else echo "CI-only, not run: lock privilege bits"; fi
fresh; echo 'auth sufficient pam_permit.so' >> "$c/etc/pam.d/jarvis-lock"; check "pam_permit in the lock PAM is caught" caught
fresh; rm "$c/etc/pam.d/jarvis-lock"; check "missing lock PAM is caught" caught
fresh; sed -i.bak '/W-l/d' "$c/etc/xdg/labwc/rc.xml"; check "missing Super+L bind is caught" caught
fresh; sed -i.bak '/W-space/d' "$c/etc/xdg/labwc/rc.xml"; check "missing Super+Space bind is caught" caught
fresh; sed -i.bak '/jarvis-idle/d' "$c/etc/xdg/labwc/autostart"; check "idle lock not started is caught" caught
fresh; sed -i.bak '/import-environment/d' "$c/etc/xdg/labwc/autostart"; check "Wayland env not imported is caught" caught
fresh; sed -i.bak 's/ --merge-config//' "$c/usr/local/bin/labwc"; check "labwc without merged config is caught" caught
fresh; rm "$c/usr/share/jarvis/voice/manifest.json"; check "missing voice manifest is caught" caught
fresh; rm "$c/usr/lib/jarvis/voice/bin/piper"; check "missing piper is caught" caught
fresh; echo '"os.jarvis.helper.admin"' >> "$c/usr/share/polkit-1/rules.d/51-jarvis-settings.rules"; check "a rule naming the admin action is caught" caught
fresh; rm "$c/etc/systemd/system/bluetooth.target.wants/bluetooth.service"; check "bluetooth not enabled is caught" caught
fresh; sed -i.bak '/^Package: udisks2$/,+1d' "$c/var/lib/dpkg/status"; check "a missing runtime package is caught" caught

fresh; sed -i.bak 's/W-l/W-x/' "$c/etc/xdg/labwc/rc.xml"; check "wrong lock key is caught" caught
fresh; sed -i.bak 's/W-space/W-x/' "$c/etc/xdg/labwc/rc.xml"; check "wrong voice key is caught" caught
fresh; sed -i.bak 's/ DISPLAY//' "$c/etc/xdg/labwc/autostart"; check "missing DISPLAY import is caught" caught
if [ "$(uname -s)" = Linux ]; then fresh; chmod g+s "$c/usr/bin/jarvis-lock"; check "a setgid jarvis-lock is caught" caught; else echo "CI-only, not run: lock privilege bits"; fi
fresh; chmod a-x "$c/usr/bin/jarvis-lock"; check "a nonexecutable lock is caught" caught
fresh; rm "$c/usr/libexec/jarvis/jarvis-idle-loop"; check "missing idle loop is caught" caught
fresh; rm "$c/usr/lib/jarvis/voice/bin/whisper-cli"; check "missing whisper is caught" caught
fresh; rm "$c/usr/share/polkit-1/rules.d/51-jarvis-settings.rules"; check "missing settings policy is caught" caught
fresh; echo 'polkit.addRule(function (action, subject) { if (action.id == "os.jarvis.helper.admin" && subject.isInGroup("jarvis-admins")) return polkit.Result.YES; });' > "$c/usr/share/polkit-1/rules.d/50-jarvis.rules"
check "helper admin grant is allowed because PAM is the password gate" "$v" "$c"
fresh; rm "$c/var/lib/dpkg/status"
check "missing status is caught" caught
out=$("$v" "$c" 2>&1 || true)
check "each diagnostic has verify-m3 prefix" test -z "$(printf '%s\n' "$out" | grep -v '^verify-m3: ')"

if command -v dpkg-deb >/dev/null; then
  "$ISO_DIR/dev/stub-debs.sh" "$tmp/stubs" >/dev/null
  for p in jarvis-settings jarvis-apps jarvis-wl jarvis-lock jarvis-idle jarvis-voice-models jarvis-voice-engines; do
    check "stub $p built" test -f "$tmp/stubs/${p}_0.0.0~stub1_amd64.deb"
  done
  check "stub lock ships the real PAM service" cmp -s "$REPO_ROOT/os/packaging/jarvis-lock/pam" \
    <(dpkg-deb --fsys-tarfile "$tmp/stubs/jarvis-lock_0.0.0~stub1_amd64.deb" | tar -xO ./etc/pam.d/jarvis-lock)
  check "stub idle ships the real loop" cmp -s "$REPO_ROOT/os/packaging/jarvis-idle/jarvis-idle-loop" \
    <(dpkg-deb --fsys-tarfile "$tmp/stubs/jarvis-idle_0.0.0~stub1_amd64.deb" | tar -xO ./usr/libexec/jarvis/jarvis-idle-loop)
  check "stub settings ships the real polkit rule" cmp -s "$REPO_ROOT/os/packaging/jarvis-settings/51-jarvis-settings.rules" \
    <(dpkg-deb --fsys-tarfile "$tmp/stubs/jarvis-settings_0.0.0~stub1_amd64.deb" | tar -xO ./usr/share/polkit-1/rules.d/51-jarvis-settings.rules)
else
  if [ "$(uname -s)" = Linux ]; then
    fail "stub debs: dpkg-deb missing (run through os/packaging/dev/trixie.sh)"
  else echo "CI-only, not run: stub debs require Linux dpkg-deb"; fi
fi
finish
