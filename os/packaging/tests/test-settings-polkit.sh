#!/usr/bin/env bash
# 51-jarvis-settings.rules grants exactly the session-level actions the
# settings/disks tools need, to jarvis-admins only (M3 Review Focus 3).
source "$(dirname "$0")/lib.sh"
command -v node >/dev/null || { echo "SKIP test-settings-polkit.sh: needs node (TRIXIE_PACKAGES=nodejs)" >&2; exit 1; }
rules=$PACKAGING_DIR/jarvis-settings/51-jarvis-settings.rules
ev() { node "$TESTS_DIR/polkit-eval.mjs" "$1" "$2" "$3"; }
granted="org.freedesktop.NetworkManager.enable-disable-wifi
org.freedesktop.UPower.PowerProfiles.switch-profile
net.hadess.PowerProfiles.switch-profile
org.freedesktop.udisks2.filesystem-mount
org.freedesktop.udisks2.eject-media
org.freedesktop.udisks2.power-off-drive"
for a in $granted; do
  check "jarvis-admins may $a" test "$(ev "$rules" "$a" jarvis-admins)" = yes
  check "a non-member is not granted $a" test "$(ev "$rules" "$a" users,sudo)" = not_handled
done
for a in os.jarvis.helper.admin os.jarvis.helper.packages \
  org.freedesktop.udisks2.filesystem-mount-system org.freedesktop.udisks2.filesystem-mount-other-seat \
  org.freedesktop.udisks2.filesystem-unmount-others org.freedesktop.udisks2.modify-device \
  org.freedesktop.udisks2.modify-device-system org.freedesktop.udisks2.open-device \
  org.freedesktop.udisks2.loop-setup org.freedesktop.udisks2.encrypted-unlock-system \
  org.freedesktop.NetworkManager.settings.modify.system org.freedesktop.NetworkManager.network-control \
  org.freedesktop.login1.power-off org.freedesktop.policykit.exec; do
  check "never granted: $a" test "$(ev "$rules" "$a" jarvis-admins)" = not_handled
done
check "exactly six action ids in the rule" test "$(grep -Ec '^ *"(org|net)\.' "$rules")" -eq 6
check "the rule never names the helper's admin action" bash -c "! grep -q 'helper.admin' '$rules'"
# Contracts §5.5: M1's rule grants the helper admin action to jarvis-admins;
# the helper's own PAM check of adminPassword is the password gate.
check "helper admin granted by 50-jarvis.rules to jarvis-admins only" \
  test "$(ev "$PACKAGING_DIR/jarvis-helper/50-jarvis.rules" os.jarvis.helper.admin jarvis-admins)" = yes
check "helper admin not granted to non-members" \
  test "$(ev "$PACKAGING_DIR/jarvis-helper/50-jarvis.rules" os.jarvis.helper.admin users)" = not_handled

if command -v dpkg-deb >/dev/null; then
  tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
  install -D -m0755 /bin/true "$tmp/dist/usr/lib/jarvis/mcp/jarvis-settings"
  GO_DIST=$tmp/dist "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-settings >/dev/null
  deb=$tmp/out/jarvis-settings_${OS_VERSION}_amd64.deb
  check "rule shipped 0644" test "$(deb_mode "$deb" usr/share/polkit-1/rules.d/51-jarvis-settings.rules)" = "-rw-r--r--"
fi
finish
