#!/usr/bin/env bash
# jarvis-settings, jarvis-apps, jarvis-wl (+ helper admin deps) from a fake
# `make -C os/go dist` tree (M3 contracts §1).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
dist=$tmp/dist
fake_bin() { install -D -m0755 /bin/true "$dist/$1"; }
fake_text() { install -D -m0644 /dev/null "$dist/$1"; echo "# $1" > "$dist/$1"; }
fake_bin usr/lib/jarvis/mcp/jarvis-settings
fake_bin usr/lib/jarvis/mcp/jarvis-apps
fake_bin usr/libexec/jarvis/jarvis-wl
fake_bin usr/libexec/jarvis/jarvis-helper
fake_text usr/share/dbus-1/system.d/os.jarvis.Helper1.conf
fake_text usr/share/dbus-1/system-services/os.jarvis.Helper1.service
fake_text usr/lib/systemd/system/jarvis-helper.service
fake_text usr/share/polkit-1/actions/os.jarvis.helper.policy

GO_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-settings jarvis-apps jarvis-wl jarvis-helper >/dev/null
d() { echo "$tmp/out/${1}_${OS_VERSION}_amd64.deb"; }
check "jarvis-settings at contract path" deb_has "$(d jarvis-settings)" usr/lib/jarvis/mcp/jarvis-settings
check "jarvis-settings 0755" test "$(deb_mode "$(d jarvis-settings)" usr/lib/jarvis/mcp/jarvis-settings)" = "-rwxr-xr-x"
check "jarvis-apps at its path" deb_has "$(d jarvis-apps)" usr/lib/jarvis/mcp/jarvis-apps
check "jarvis-wl at its path" deb_has "$(d jarvis-wl)" usr/libexec/jarvis/jarvis-wl
check "jarvis-wl 0755" test "$(deb_mode "$(d jarvis-wl)" usr/libexec/jarvis/jarvis-wl)" = "-rwxr-xr-x"

sdeps=$(deb_field "$(d jarvis-settings)" Depends)
check "settings needs the same-version helper (users.*, disks.format_removable)" grep -qF "jarvis-helper (= $OS_VERSION)" <<<"$sdeps"
for p in brightnessctl wireplumber wlsunset bluez power-profiles-daemon wlr-randr udisks2 network-manager rfkill; do
  check "settings Depends has $p" grep -qw -- "$p" <<<"$sdeps"
done
adeps=$(deb_field "$(d jarvis-apps)" Depends)
check "apps needs the same-version jarvis-wl" grep -qF "jarvis-wl (= $OS_VERSION)" <<<"$adeps"
for p in xdg-utils flatpak; do check "apps Depends has $p" grep -qw -- "$p" <<<"$adeps"; done
hdeps=$(deb_field "$(d jarvis-helper)" Depends)
for p in passwd dosfstools exfatprogs e2fsprogs util-linux libpam-modules; do
  check "helper Depends has $p (admin methods)" grep -qw -- "$p" <<<"$hdeps"
done

# The helper checks admin passwords with unix_chkpwd, not a PAM conversation
# (threat model M28), so it ships no /etc/pam.d file that would have no effect.
check "helper ships no jarvis-admin PAM service (it would never be read)" test -z "$(dpkg-deb -c "$(d jarvis-helper)" | grep 'pam.d/jarvis-admin' || true)"

rm "$dist/usr/libexec/jarvis/jarvis-wl"
err=$(GO_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out2" jarvis-wl 2>&1 || true)
check "missing jarvis-wl fails the build" test ! -e "$tmp/out2/jarvis-wl_${OS_VERSION}_amd64.deb"
check "error names Plan M's build" grep -q 'make -C os/go dist' <<<"$err"
finish
