#!/usr/bin/env bash
# jarvis-cu (v1.1 contracts §1): Plan U's helper at its contract path, the user
# unit that confines it (no network: screenshots stay local), and the labwc
# autostart fragment that starts it only in the full session (Review Focus 1, 2).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
d=$PACKAGING_DIR/jarvis-cu
dist=$tmp/dist
install -D -m0755 /bin/true "$dist/usr/libexec/jarvis/jarvis-cu"
GO_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-cu >/dev/null
deb=$tmp/out/jarvis-cu_${OS_VERSION}_amd64.deb
check "binary at the contract path" deb_has "$deb" usr/libexec/jarvis/jarvis-cu
check "binary 0755" test "$(deb_mode "$deb" usr/libexec/jarvis/jarvis-cu)" = "-rwxr-xr-x"
check "user unit shipped" deb_has "$deb" usr/lib/systemd/user/jarvis-cu.service
check "autostart fragment shipped" deb_has "$deb" usr/share/jarvis-cu/labwc/autostart
check "root-owned files" test "$(deb_owners "$deb")" = "root/root"
deps=$(deb_field "$deb" Depends)
for p in at-spi2-core iproute2 systemd; do check "Depends has $p" grep -qw -- "$p" <<<"$deps"; done
check "no maintainer scripts: never enabled for every user (the autostart starts it)" \
  bash -c '! dpkg-deb --ctrl-tarfile "$1" | tar -t | grep -qE "(post|pre)(inst|rm)"' _ "$deb"

u=$d/jarvis-cu.service
check "unit runs the contract binary" grep -qx 'ExecStart=/usr/libexec/jarvis/jarvis-cu' "$u"
for line in 'UMask=0077' 'NoNewPrivileges=yes' 'RestrictAddressFamilies=AF_UNIX AF_NETLINK' 'Restart=on-failure' \
  'ConditionEnvironment=WAYLAND_DISPLAY' 'LockPersonality=yes' 'RestrictNamespaces=yes'; do
  check "unit: $line" grep -qx "$line" "$u"
done
check "unit has no [Install] (labwc autostart starts it, contracts §1)" bash -c '! grep -q "^\[Install\]" "$1"' _ "$u"
check "unit never restarts against a compositor that is gone" grep -q '^ExecCondition=.*XDG_RUNTIME_DIR/\$WAYLAND_DISPLAY' "$u"

f=$d/labwc-autostart
check "fragment is POSIX sh" sh -n "$f"
mkdir -p "$tmp/bin"
printf '#!/bin/sh\necho "$*" >> "%s/systemctl.calls"\n' "$tmp" > "$tmp/bin/systemctl"
chmod +x "$tmp/bin/systemctl"
: > "$tmp/systemctl.calls"
PATH=$tmp/bin:$PATH JARVIS_SESSION_MODE=full sh -c ". '$f'"
check "full session starts the helper" grep -qx -- '--user start --no-block jarvis-cu.service' "$tmp/systemctl.calls"
: > "$tmp/systemctl.calls"
PATH=$tmp/bin:$PATH sh -c "unset JARVIS_SESSION_MODE; . '$f'"
check "no mode (live session) counts as full" grep -qx -- '--user start --no-block jarvis-cu.service' "$tmp/systemctl.calls"
: > "$tmp/systemctl.calls"
PATH=$tmp/bin:$PATH JARVIS_SESSION_MODE=classic sh -c ". '$f'"
check "classic session never starts it (no overlay to watch and stop it)" test ! -s "$tmp/systemctl.calls"

if command -v systemd-analyze >/dev/null; then
  errs=$(systemd-analyze --user verify --man=no "$u" 2>&1 | grep -E 'Unknown (key|section)|Failed to parse|Invalid' || true)
  check "systemd-analyze finds no unit syntax errors" test -z "$errs"
else
  echo "SKIP systemd-analyze (not installed)"
fi

rm "$dist/usr/libexec/jarvis/jarvis-cu"
err=$(GO_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out2" jarvis-cu 2>&1 || true)
check "missing helper fails the build" test ! -e "$tmp/out2/jarvis-cu_${OS_VERSION}_amd64.deb"
check "error names Plan U's build" grep -q 'make -C os/go dist' <<<"$err"
install -D -m0755 /bin/true "$dist/usr/libexec/jarvis/jarvis-cu"
install -D -m0644 /dev/null "$dist/usr/lib/systemd/user/jarvis-cu.service"
echo '[Service]' > "$dist/usr/lib/systemd/user/jarvis-cu.service"
err=$(GO_DIST=$dist "$PACKAGING_DIR/build.sh" --out "$tmp/out3" jarvis-cu 2>&1 || true)
check "a different unit in os/go/dist fails the build (one owner, gap G4)" grep -q 'Reconcile them' <<<"$err"
finish
