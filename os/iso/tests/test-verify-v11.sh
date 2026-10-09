#!/usr/bin/env bash
# verify-v11.sh catches each missing or unsafe v1.1 piece (Review Focus 1, 2).
source "$(dirname "$0")/lib.sh"
source "$(dirname "$0")/v11-fixture.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
v=$ISO_DIR/scripts/verify-v11.sh
c=$tmp/c
fresh() { rm -rf "$c"; v11_fixture "$c"; }
caught() {
  local rc=0
  "$v" "$c" >"$tmp/result" 2>&1 || rc=$?
  [ "$rc" -eq 1 ] && grep -q '^verify-v11: ' "$tmp/result"
}
fresh; check "complete v1.1 chroot verifies" "$v" "$c"
fresh; sed -i.bak '/^Package: jarvis-cu$/,/^$/d' "$c/var/lib/dpkg/status"; check "jarvis-cu not installed is caught" caught
fresh; sed -i.bak '/^Package: at-spi2-core$/,/^$/d' "$c/var/lib/dpkg/status"; check "no AT-SPI is caught" caught
fresh; rm "$c/usr/libexec/jarvis/jarvis-cu"; check "missing helper binary is caught" caught
fresh; sed -i.bak 's/^RestrictAddressFamilies=.*/RestrictAddressFamilies=AF_UNIX AF_INET/' "$c/usr/lib/systemd/user/jarvis-cu.service"
check "network address family is caught" caught
fresh; sed -i.bak 's/^RestrictAddressFamilies=.*/RestrictAddressFamilies=AF_UNIX AF_NETLINK/' "$c/usr/lib/systemd/user/jarvis-cu.service"
check "netlink beside AF_UNIX is caught (the unit is AF_UNIX only)" caught
fresh; sed -i.bak '/RestrictAddressFamilies/d' "$c/usr/lib/systemd/user/jarvis-cu.service"; check "a unit that may use the network is caught" caught
fresh; mkdir -p "$c/etc/systemd/user/default.target.wants"; ln -s /usr/lib/systemd/user/jarvis-cu.service "$c/etc/systemd/user/default.target.wants/jarvis-cu.service"
check "an enabled unit (would run in every session) is caught" caught
fresh; sed -i.bak '/jarvis-cu\/labwc\/autostart/d' "$c/etc/xdg/labwc/autostart"; check "autostart without jarvis-cu is caught" caught
fresh; echo '. /usr/share/jarvis-cu/labwc/autostart' >> "$c/etc/xdg/labwc-classic/autostart"; check "jarvis-cu in the classic session is caught" caught
fresh; sed -i.bak '/jarvis-cu.service/d' "$c/usr/libexec/jarvis/jarvis-shell-guard"; check "a fallback that leaves jarvis-cu running is caught" caught
fresh; sed -i.bak '/QT_LINUX_ACCESSIBILITY_ALWAYS_ON/d' "$c/etc/xdg/labwc/environment"; check "Qt not on the AT-SPI bus is caught" caught
fresh; rm "$c/usr/share/dbus-1/services/org.a11y.Bus.service"; check "AT-SPI bus not activatable is caught" caught
fresh; python3 - "$c/usr/share/jarvis/models/catalog.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p)); c["models"][1].pop("vision"); json.dump(c, open(p, "w"))
PY
check "a catalog model without a vision flag is caught" caught
fresh; python3 - "$c/usr/share/jarvis/models/catalog.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
for m in c["models"][1:3]: m["vision"] = True
json.dump(c, open(p, "w"))
PY
check "two local vision models are caught" caught

fresh; printf '{"models": null}\n' > "$c/usr/share/jarvis/models/catalog.json"
check "malformed catalog is caught" caught
fresh; rm "$c/var/lib/dpkg/status"
check "missing dpkg status is caught" caught
check "missing dpkg status only emits verifier diagnostics" bash -c '! grep -v "^verify-v11: " "$1"' _ "$tmp/result"
fresh; rm "$c/usr/share/jarvis/models/catalog.json"
check "missing catalog is caught" caught
fresh; rm "$c/usr/share/jarvis-cu/labwc/autostart"
check "missing helper autostart fragment is caught" caught
fresh; rm "$c/usr/lib/systemd/user/jarvis-cu.service"
check "missing helper unit is caught" caught

if command -v dpkg-deb >/dev/null; then
  "$ISO_DIR/dev/stub-debs.sh" "$tmp/stubs" >/dev/null
  check "stub jarvis-cu built" test -f "$tmp/stubs/jarvis-cu_0.0.0~stub1_amd64.deb"
  check "stub jarvis-cu ships the real unit" cmp -s "$REPO_ROOT/os/packaging/jarvis-cu/jarvis-cu.service" \
    <(dpkg-deb --fsys-tarfile "$tmp/stubs/jarvis-cu_0.0.0~stub1_amd64.deb" | tar -xO ./usr/lib/systemd/user/jarvis-cu.service)
else
  fail "stub debs: dpkg-deb missing (run through os/packaging/dev/trixie.sh)"
fi
finish
