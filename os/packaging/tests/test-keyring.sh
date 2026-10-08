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
check "sources file verbatim (contracts §7)" test "$src" = "$(printf 'Types: deb\nURIs: https://mmabdelhay.github.io/jarvis-apt\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/jarvis-archive-keyring.gpg')"
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
