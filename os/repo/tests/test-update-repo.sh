#!/usr/bin/env bash
# make-update-repo.sh: a newer jarvis-shell in a repo signed by the CI key, and a rogue copy.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
g=$tmp/g; fpr=$("$REPO_DIR/test-key.sh" "$g")
r=$tmp/stage/DEBIAN; mkdir -p "$r" "$tmp/stage/usr/share/doc/jarvis-shell"; echo x > "$tmp/stage/usr/share/doc/jarvis-shell/README"
printf 'Package: jarvis-shell\nVersion: 0.2.0~ci7\nArchitecture: amd64\nMaintainer: T <t@example.invalid>\nDepends: jarvisd (= 0.2.0~ci7)\nDescription: t\n' > "$r/control"
mkdir -p "$tmp/debs"; dpkg-deb --root-owner-group -b "$tmp/stage" "$tmp/debs/jarvis-shell_0.2.0~ci7_amd64.deb" >/dev/null
c=$tmp/cstage/DEBIAN; mkdir -p "$c"
printf 'Package: jarvis-classic\nVersion: 0.2.0~ci7\nArchitecture: amd64\nMaintainer: T <t@example.invalid>\nDepends: jarvis-ui (= 0.2.0~ci7), jarvis-shell (= 0.2.0~ci7), foot\nDescription: t\n' > "$c/control"
dpkg-deb --root-owner-group -b "$tmp/cstage" "$tmp/debs/jarvis-classic_0.2.0~ci7_amd64.deb" >/dev/null
v=$("$REPO_DIR/tests/make-update-repo.sh" "$tmp/debs" "$g" "$tmp/site")
check "new version printed" test "$v" = "0.2.0~ci7+update1"
check "good repo has it" grep -qx 'Version: 0.2.0~ci7+update1' "$tmp/site/good/dists/trixie/main/binary-amd64/Packages"
check "depends unchanged (jarvisd stays)" grep -qx 'Depends: jarvisd (= 0.2.0~ci7)' "$tmp/site/good/dists/trixie/main/binary-amd64/Packages"
check "a package pinning jarvis-shell ships with it, re-pinned" grep -qx 'Depends: jarvis-ui (= 0.2.0~ci7), jarvis-shell (= 0.2.0~ci7+update1), foot' "$tmp/site/good/dists/trixie/main/binary-amd64/Packages"
check "and newer itself" grep -q '^Filename: .*/jarvis-classic_0.2.0~ci7+update1_amd64.deb$' "$tmp/site/good/dists/trixie/main/binary-amd64/Packages"
gpg --homedir "$g" --export "$fpr" > "$tmp/ci.gpg"
check "good signed by the CI key" gpgv --keyring "$tmp/ci.gpg" "$tmp/site/good/dists/trixie/InRelease"
check "rogue NOT signed by the CI key" bash -c "! gpgv --keyring '$tmp/ci.gpg' '$tmp/site/rogue/dists/trixie/InRelease' 2>/dev/null"
finish
