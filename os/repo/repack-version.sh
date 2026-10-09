#!/usr/bin/env bash
# repack-version.sh DEB NEW_VERSION OUT_DIR [DEP=VERSION...] — same package,
# only Version changed (the update test's "newer jarvis-shell"); each
# DEP=VERSION also re-pins an exact "DEP (= ...)" dependency. Prints the new path.
set -euo pipefail
deb=$1 version=$2 outdir=$3
shift 3
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
dpkg-deb -R "$deb" "$tmp/root"
sed -i "s/^Version: .*/Version: $version/" "$tmp/root/DEBIAN/control"
for pin in "$@"; do
  dep=${pin%%=*} v=${pin#*=}
  sed -i -E "/^(Pre-)?Depends:/ s/(^|[ ,])$dep \(= [^)]*\)/\1$dep (= $v)/g" "$tmp/root/DEBIAN/control"
done
pkg=$(sed -n 's/^Package: //p' "$tmp/root/DEBIAN/control")
arch=$(sed -n 's/^Architecture: //p' "$tmp/root/DEBIAN/control")
mkdir -p "$outdir"
dpkg-deb --root-owner-group -Zxz -b "$tmp/root" "$outdir/${pkg}_${version}_${arch}.deb" >/dev/null
echo "$outdir/${pkg}_${version}_${arch}.deb"
