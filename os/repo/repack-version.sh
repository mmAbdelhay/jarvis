#!/usr/bin/env bash
# repack-version.sh DEB NEW_VERSION OUT_DIR — same package, only Version
# changed (the update test's "newer jarvis-shell"). Prints the new path.
set -euo pipefail
deb=$1 version=$2 outdir=$3
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
dpkg-deb -R "$deb" "$tmp/root"
sed -i "s/^Version: .*/Version: $version/" "$tmp/root/DEBIAN/control"
pkg=$(sed -n 's/^Package: //p' "$tmp/root/DEBIAN/control")
arch=$(sed -n 's/^Architecture: //p' "$tmp/root/DEBIAN/control")
mkdir -p "$outdir"
dpkg-deb --root-owner-group -Zxz -b "$tmp/root" "$outdir/${pkg}_${version}_${arch}.deb" >/dev/null
echo "$outdir/${pkg}_${version}_${arch}.deb"
