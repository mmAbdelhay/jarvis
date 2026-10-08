#!/usr/bin/env bash
# control.in may use brand placeholders; build-deb renders them.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/root/usr/share/doc/x"; echo hi > "$tmp/root/usr/share/doc/x/README"
cat > "$tmp/control.in" <<'EOF'
Package: brand-probe
Version: @VERSION@
Architecture: all
Maintainer: T <t@example.invalid>
Installed-Size: @INSTALLED_SIZE@
Description: @DISTRO_NAME@ probe
 Long text for @PRETTY_NAME@.
EOF
deb=$("$PACKAGING_DIR/lib/build-deb.sh" --control "$tmp/control.in" --root "$tmp/root" --out "$tmp/out" --version "$OS_VERSION")
check "short description rendered" test "$(deb_field "$deb" Description | head -n1)" = "Rafiq probe"
check "long description rendered" grep -qF 'Long text for Rafiq 0.2 (trixie).' <<<"$(deb_field "$deb" Description)"
# Only jarvis-shell: agent packages are brand-neutral (M2.5 §6), see test-agent.sh
check "jarvis-shell control.in uses the brand" grep -q '@DISTRO_NAME@' "$PACKAGING_DIR/jarvis-shell/control.in"
finish
