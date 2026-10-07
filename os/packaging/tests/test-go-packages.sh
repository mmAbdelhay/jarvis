#!/usr/bin/env bash
# jarvis-pkg, jarvis-diag, jarvis-helper from a fake `make -C os/go dist` tree.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

dist=$tmp/dist
fake_bin() { install -D -m0755 /bin/true "$dist/$1"; }
fake_text() { install -D -m0644 /dev/null "$dist/$1"; echo "# $1" > "$dist/$1"; }
fake_bin usr/lib/jarvis/mcp/jarvis-pkg
fake_bin usr/lib/jarvis/mcp/jarvis-diag
fake_bin usr/libexec/jarvis/jarvis-helper
fake_text usr/share/dbus-1/system.d/os.jarvis.Helper1.conf
fake_text usr/share/dbus-1/system-services/os.jarvis.Helper1.service
fake_text usr/lib/systemd/system/jarvis-helper.service
fake_text usr/share/polkit-1/actions/os.jarvis.helper.policy

GO_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-pkg jarvis-diag jarvis-helper >/dev/null
pkg=$tmp/out/jarvis-pkg_${OS_VERSION}_amd64.deb
diag=$tmp/out/jarvis-diag_${OS_VERSION}_amd64.deb
helper=$tmp/out/jarvis-helper_${OS_VERSION}_amd64.deb

check "jarvis-pkg at contract path" deb_has "$pkg" usr/lib/jarvis/mcp/jarvis-pkg
check "jarvis-pkg executable" test "$(deb_mode "$pkg" usr/lib/jarvis/mcp/jarvis-pkg)" = "-rwxr-xr-x"
check "jarvis-diag at contract path" deb_has "$diag" usr/lib/jarvis/mcp/jarvis-diag
check "pkg needs the same-version helper" grep -qF "jarvis-helper (= $OS_VERSION)" <<<"$(deb_field "$pkg" Depends)"
check "diag needs the same-version helper" grep -qF "jarvis-helper (= $OS_VERSION)" <<<"$(deb_field "$diag" Depends)"
check "diag needs network-manager" grep -q 'network-manager' <<<"$(deb_field "$diag" Depends)"
for path in usr/libexec/jarvis/jarvis-helper \
  usr/share/dbus-1/system.d/os.jarvis.Helper1.conf \
  usr/share/dbus-1/system-services/os.jarvis.Helper1.service \
  usr/lib/systemd/system/jarvis-helper.service \
  usr/share/polkit-1/actions/os.jarvis.helper.policy; do
  check "helper ships /$path" deb_has "$helper" "$path"
done
check "helper binary 0755" test "$(deb_mode "$helper" usr/libexec/jarvis/jarvis-helper)" = "-rwxr-xr-x"
check "polkit policy 0644" test "$(deb_mode "$helper" usr/share/polkit-1/actions/os.jarvis.helper.policy)" = "-rw-r--r--"
check "helper postinst reloads the system bus" grep -q 'ReloadConfig' <<<"$(deb_script "$helper" postinst)"
check "polkit rule shipped 0644" test "$(deb_mode "$helper" usr/share/polkit-1/rules.d/50-jarvis.rules)" = "-rw-r--r--"
rules=$(dpkg-deb --fsys-tarfile "$helper" | tar -xO ./usr/share/polkit-1/rules.d/50-jarvis.rules)
check "rule grants package actions" grep -q '"os.jarvis.helper.packages"' <<<"$rules"
check "rule grants service actions" grep -q '"os.jarvis.helper.services"' <<<"$rules"
check "rule is scoped to jarvis-admins" grep -q 'isInGroup("jarvis-admins")' <<<"$rules"
check "rule does not grant the reserved admin action" bash -c '! grep -q os.jarvis.helper.admin' <<<"$rules"
check "postinst creates jarvis-admins" grep -q 'jarvis-admins' <<<"$(deb_script "$helper" postinst)"
check "helper is D-Bus activated, never enabled" bash -c "! grep -q 'systemctl enable' <<<\"\$(dpkg-deb --ctrl-tarfile '$helper' | tar -xO ./postinst)\""

rm "$dist/usr/share/polkit-1/actions/os.jarvis.helper.policy"
err=$(GO_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out2" jarvis-helper 2>&1 || true)
check "missing contract file fails the build" test ! -e "$tmp/out2/jarvis-helper_${OS_VERSION}_amd64.deb"
check "error names the upstream command" grep -q 'make -C os/go dist' <<<"$err"

finish
