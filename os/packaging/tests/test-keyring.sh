#!/usr/bin/env bash
# jarvis-archive-keyring (contracts §7).
source "$(dirname "$0")/lib.sh"
REPO_ROOT=$(cd "$PACKAGING_DIR/../.." && pwd)
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
command -v gpg >/dev/null || { echo "SKIP test-keyring.sh (needs gpg)"; exit 0; }
g=$tmp/g; mkdir -m700 "$g"
fpr=$("$REPO_ROOT/os/repo/test-key.sh" "$g")
JARVIS_ARCHIVE_PUBKEY=$g/pubkey.asc "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-archive-keyring >/dev/null
deb=$tmp/out/jarvis-archive-keyring_${OS_VERSION}_all.deb
check "keyring at contract path" deb_has "$deb" usr/share/keyrings/jarvis-archive-keyring.gpg
check "keyring 0644" test "$(deb_mode "$deb" usr/share/keyrings/jarvis-archive-keyring.gpg)" = "-rw-r--r--"
dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/keyrings/jarvis-archive-keyring.gpg > "$tmp/k.gpg"
check "binary (dearmored) keyring" bash -c "! grep -q 'BEGIN PGP' '$tmp/k.gpg'"
check "holds the given key" grep -q "$fpr" <<<"$(gpg --show-keys --with-colons "$tmp/k.gpg")"
src=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./etc/apt/sources.list.d/jarvis.sources)
fields() { grep -v '^#' <<<"$1"; }
want='Types: deb\nURIs: https://mmabdelhay.github.io/jarvis-apt\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/jarvis-archive-keyring.gpg\nEnabled: %s'
# shellcheck disable=SC2059
check "sources file verbatim, disabled by default (contracts §7)" test "$(fields "$src")" = "$(printf "$want" no)"
check "sources comment says when it is enabled" grep -q '^# .*Enabled' <<<"$src"
JARVIS_APT_REPO_ENABLED=1 JARVIS_ARCHIVE_PUBKEY=$g/pubkey.asc "$PACKAGING_DIR/build.sh" --out "$tmp/on" jarvis-archive-keyring >/dev/null
src_on=$(dpkg-deb --fsys-tarfile "$tmp/on/jarvis-archive-keyring_${OS_VERSION}_all.deb" | tar -xO ./etc/apt/sources.list.d/jarvis.sources)
# shellcheck disable=SC2059
check "JARVIS_APT_REPO_ENABLED=1 enables the source" test "$(fields "$src_on")" = "$(printf "$want" yes)"
check "JARVIS_APT_REPO_ENABLED other than 0/1 fails" bash -c '! JARVIS_APT_REPO_ENABLED=true JARVIS_ARCHIVE_PUBKEY="$1" "$2" --out "$3" jarvis-archive-keyring >/dev/null 2>&1' _ "$g/pubkey.asc" "$PACKAGING_DIR/build.sh" "$tmp/bad"
if command -v apt-get >/dev/null; then
  # apt itself reads the deb822 Enabled field: nothing to fetch from the disabled source.
  targets() { mkdir -p "$tmp/apt-$2/partial"; printf '%s\n' "$1" > "$tmp/apt-$2/jarvis.sources"
    apt-get -o Dir::Etc::SourceList=/dev/null -o Dir::Etc::SourceParts="$tmp/apt-$2" \
      -o Dir::State::Lists="$tmp/apt-$2" -o Debug::NoLocking=true update --print-uris 2>&1; }
  check "apt ignores the disabled source" bash -c '! grep -q jarvis-apt <<<"$1"' _ "$(targets "$src" off)"
  check "apt reads the enabled source" grep -q jarvis-apt <<<"$(targets "$src_on" on)"
fi
check "sources is a conffile" grep -qx /etc/apt/sources.list.d/jarvis.sources <<<"$(dpkg-deb --ctrl-tarfile "$deb" | tar -xO ./conffiles)"
# The committed key path: fingerprint must match FINGERPRINT.
mkdir -p "$tmp/keys"; cp "$g/pubkey.asc" "$tmp/keys/jarvis-archive-keyring.asc"; echo "$fpr" > "$tmp/keys/FINGERPRINT"
check "committed key with matching FINGERPRINT builds" bash -c "JARVIS_REPO_KEYS_DIR='$tmp/keys' '$PACKAGING_DIR/build.sh' --out '$tmp/o2' jarvis-archive-keyring >/dev/null"
echo 0000000000000000000000000000000000000000 > "$tmp/keys/FINGERPRINT"
check "fingerprint mismatch fails" bash -c "! JARVIS_REPO_KEYS_DIR='$tmp/keys' '$PACKAGING_DIR/build.sh' --out '$tmp/o3' jarvis-archive-keyring >/dev/null 2>&1"
mkdir -p "$tmp/empty"
err=$(JARVIS_REPO_KEYS_DIR=$tmp/empty "$PACKAGING_DIR/build.sh" --out "$tmp/o4" jarvis-archive-keyring 2>&1 || true)
check "no key at all fails and names the runbook" grep -q 'os/repo/README.md' <<<"$err"
check "release refuses throwaway keyring" bash -c '! GITHUB_REF=refs/tags/os-v0.2.0 JARVIS_ARCHIVE_PUBKEY="$1" "$2" --out "$3" jarvis-archive-keyring >/dev/null 2>&1' _ "$g/pubkey.asc" "$PACKAGING_DIR/build.sh" "$tmp/release"
finish
