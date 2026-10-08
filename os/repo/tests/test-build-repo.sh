#!/usr/bin/env bash
# build-repo.sh: signed suites apt accepts; other suite kept; repack.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
g=$tmp/g; fpr=$("$REPO_DIR/test-key.sh" "$g")

mkdeb() { # mkdeb NAME VERSION OUTDIR
  local r=$tmp/stage-$1-$2
  mkdir -p "$r/DEBIAN" "$r/usr/share/doc/$1"
  echo "$1 $2" > "$r/usr/share/doc/$1/README"
  printf 'Package: %s\nVersion: %s\nArchitecture: amd64\nMaintainer: T <t@example.invalid>\nDescription: test %s\n' "$1" "$2" "$1" > "$r/DEBIAN/control"
  mkdir -p "$3"; dpkg-deb --root-owner-group -b "$r" "$3/${1}_${2}_amd64.deb" >/dev/null
}
mkdeb jarvis-shell 1.0 "$tmp/stable"
mkdeb jarvis-shell 1.1~ci5 "$tmp/testing"

"$REPO_DIR/build-repo.sh" --suite trixie --debs "$tmp/stable" --out "$tmp/site1" --gnupghome "$g" --sign-with "$fpr" >/dev/null
check "InRelease signed" grep -q 'BEGIN PGP SIGNED MESSAGE' "$tmp/site1/dists/trixie/InRelease"
check "Release.gpg present" test -s "$tmp/site1/dists/trixie/Release.gpg"
check "Origin is the brand" grep -qx 'Origin: Rafiq' "$tmp/site1/dists/trixie/Release"
check "public key published" grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$tmp/site1/jarvis-archive-keyring.gpg"
check ".nojekyll" test -e "$tmp/site1/.nojekyll"
check "no reprepro db/conf published" bash -c "[ ! -e '$tmp/site1/db' ] && [ ! -e '$tmp/site1/conf' ]"

"$REPO_DIR/build-repo.sh" --suite trixie-testing --debs "$tmp/testing" --out "$tmp/site2" --gnupghome "$g" --sign-with "$fpr" --previous "$tmp/site1" >/dev/null
check "testing has the new build" grep -qx 'Version: 1.1~ci5' "$tmp/site2/dists/trixie-testing/main/binary-amd64/Packages"
check "stable kept (Review Focus 5)" grep -qx 'Version: 1.0' "$tmp/site2/dists/trixie/main/binary-amd64/Packages"
check "stable pool file still there" test -f "$tmp/site2/pool/main/j/jarvis-shell/jarvis-shell_1.0_amd64.deb"

# apt verifies both suites with the keyring (criterion 10), no root needed.
gpg --homedir "$g" --export "$fpr" > "$tmp/keyring.gpg"
mkdir -p "$tmp/apt/lists/partial" "$tmp/apt/cache/archives/partial" "$tmp/apt/etc/sources.list.d" "$tmp/apt/etc/preferences.d" "$tmp/apt/etc/apt.conf.d"
: > "$tmp/apt/status"
aptget() { apt-get -o Dir::Etc="$tmp/apt/etc" -o Dir::State::Lists="$tmp/apt/lists" -o Dir::Cache="$tmp/apt/cache" \
  -o Dir::State::status="$tmp/apt/status" -o Debug::NoLocking=1 -o APT::Sandbox::User="$(id -un)" "$@"; }
printf 'Types: deb\nURIs: file:%s\nSuites: trixie trixie-testing\nComponents: main\nSigned-By: %s\n' "$tmp/site2" "$tmp/keyring.gpg" > "$tmp/apt/etc/sources.list.d/t.sources"
out=$(aptget update 2>&1); code=$?
check "apt update verifies both suites" test "$code" -eq 0
check "no signature warnings" bash -c "! grep -qE '^(W|E):' <<<\"\$1\"" _ "$out"
g2=$tmp/g2; "$REPO_DIR/test-key.sh" "$g2" >/dev/null; gpg --homedir "$g2" --export > "$tmp/other.gpg"
sed -i "s#Signed-By: .*#Signed-By: $tmp/other.gpg#" "$tmp/apt/etc/sources.list.d/t.sources"
rm -rf "$tmp/apt/lists"; mkdir -p "$tmp/apt/lists/partial"
check "a different key is rejected" bash -c "out=\$(apt-get -o Dir::Etc='$tmp/apt/etc' -o Dir::State::Lists='$tmp/apt/lists' -o Dir::Cache='$tmp/apt/cache' -o Dir::State::status='$tmp/apt/status' -o Debug::NoLocking=1 -o APT::Sandbox::User=\"\$(id -un)\" update 2>&1); grep -qiE 'NO_PUBKEY|not signed|signature|Missing key' <<<\"\$out\""

check "empty debs dir fails" bash -c "mkdir -p '$tmp/none' && ! '$REPO_DIR/build-repo.sh' --suite trixie --debs '$tmp/none' --out '$tmp/s3' --gnupghome '$g' --sign-with '$fpr' 2>/dev/null"
check "unknown suite fails" bash -c "! '$REPO_DIR/build-repo.sh' --suite sid --debs '$tmp/stable' --out '$tmp/s4' --gnupghome '$g' --sign-with '$fpr' 2>/dev/null"

new=$("$REPO_DIR/repack-version.sh" "$tmp/stable/jarvis-shell_1.0_amd64.deb" 1.0+update1 "$tmp/re")
check "repacked version" test "$(dpkg-deb -f "$new" Version)" = "1.0+update1"
check "repacked file name" test "$(basename "$new")" = "jarvis-shell_1.0+update1_amd64.deb"
check "repacked contents identical" bash -c "diff <(dpkg-deb -c '$tmp/stable/jarvis-shell_1.0_amd64.deb' | awk '{print \$6}') <(dpkg-deb -c '$new' | awk '{print \$6}')"
finish
