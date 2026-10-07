#!/usr/bin/env bash
# build.sh + lib/build-deb.sh against a throwaway package definition.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT

defs=$tmp/defs
mkdir -p "$defs/demo"
cat > "$defs/demo/control.in" <<'EOF'
Package: demo
Version: @VERSION@
Architecture: amd64
Maintainer: Test <test@example.invalid>
Installed-Size: @INSTALLED_SIZE@
Depends: base-files
Section: misc
Priority: optional
Description: demo package for the packaging tests
 Built from a staged tree by build-deb.sh.
EOF
cat > "$defs/demo/stage.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
install -D -m0755 /bin/true "$1/usr/lib/demo/demo-bin"
install -D -m0644 /dev/null "$1/usr/share/demo/empty.txt"
install -D -m0644 /dev/null "$1/etc/demo/demo.conf"
printf '# runtime list from upstream\nfoo-runtime\n\nbar-runtime\n' > "$1/.extra-depends"
EOF
chmod +x "$defs/demo/stage.sh"
printf '#!/bin/sh\nset -e\nexit 0\n' > "$defs/demo/postinst"

JARVIS_PACKAGING_DEFS=$defs "$PACKAGING_DIR/build.sh" --out "$tmp/out" demo >/dev/null
deb=$tmp/out/demo_${OS_VERSION}_amd64.deb

check "named <package>_<version>_<arch>.deb" test -f "$deb"
check "version substituted" test "$(deb_field "$deb" Version)" = "$OS_VERSION"
check "installed size is a number" grep -Eqx '[0-9]+' <<<"$(deb_field "$deb" Installed-Size)"
check "hand-written Depends kept" grep -q 'base-files' <<<"$(deb_field "$deb" Depends)"
check "shlibs of /bin/true appended" grep -q 'libc6' <<<"$(deb_field "$deb" Depends)"
check "stage-listed runtime deps appended" grep -q 'base-files, foo-runtime, bar-runtime' <<<"$(deb_field "$deb" Depends)"
check ".extra-depends not packed" bash -c "! dpkg-deb -c '$deb' | grep -q extra-depends"
check "binary keeps 0755" test "$(deb_mode "$deb" usr/lib/demo/demo-bin)" = "-rwxr-xr-x"
check "data file is 0644" test "$(deb_mode "$deb" usr/share/demo/empty.txt)" = "-rw-r--r--"
check "every file owned by root" test "$(deb_owners "$deb")" = "root/root"
check "postinst shipped executable" test "$(deb_script_mode "$deb" postinst)" = "-rwxr-xr-x"
check "md5sums lists the binary" grep -q ' usr/lib/demo/demo-bin$' <<<"$(deb_script "$deb" md5sums)"
check "files under /etc are conffiles" grep -qx '/etc/demo/demo.conf' <<<"$(deb_script "$deb" conffiles)"

# A placeholder nobody fills is a build error, not a literal in the control file.
mkdir -p "$defs/bad"
sed 's/^Section: misc/Section: @NOPE@/' "$defs/demo/control.in" | sed 's/^Package: demo/Package: bad/' > "$defs/bad/control.in"
cp "$defs/demo/stage.sh" "$defs/bad/stage.sh"
check "unfilled placeholder fails" bash -c "! JARVIS_PACKAGING_DEFS='$defs' '$PACKAGING_DIR/build.sh' --out '$tmp/out' bad 2>/dev/null"

mkdir -p "$defs/nostage"
cp "$defs/demo/control.in" "$defs/nostage/control.in"
err=$(JARVIS_PACKAGING_DEFS=$defs "$PACKAGING_DIR/build.sh" --out "$tmp/out" nostage 2>&1 || true)
check "missing stage.sh named in the error" grep -q 'stage.sh' <<<"$err"

# version.sh: OS_VERSION wins; otherwise a valid Debian version.
check "OS_VERSION wins" test "$(OS_VERSION=1.2.3 "$PACKAGING_DIR/version.sh")" = "1.2.3"
check "default version is valid for dpkg" bash -c "v=\$(env -u OS_VERSION '$PACKAGING_DIR/version.sh'); dpkg --validate-version \"\$v\""

finish
