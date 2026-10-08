#!/usr/bin/env bash
# make-update-repo.sh DEBS_DIR GNUPGHOME OUT — the install test's update
# server content (design §13 test 5): OUT/good has jarvis-shell <V>+update1
# signed with GNUPGHOME's key (the key the ISO's keyring was built from),
# plus <W>+update1 of every package in DEBS_DIR that pins jarvis-shell (= <V>)
# (jarvis-classic), re-pinned, as a real release would ship them together;
# OUT/rogue has the same, signed by a fresh throwaway key. Prints <V>+update1.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
debs=$1 gh=$2 out=$3
deb=$(compgen -G "$debs/jarvis-shell_*_amd64.deb" | head -n1)
[ -n "$deb" ] || { echo "make-update-repo: no jarvis-shell .deb in $debs" >&2; exit 1; }
old=$(dpkg-deb -f "$deb" Version)
version="$old+update1"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
"$here/repack-version.sh" "$deb" "$version" "$tmp/debs" >/dev/null
# Otherwise apt keeps jarvis-shell back: upgrading it alone would break them.
for d in "$debs"/*.deb; do
  [ "$d" != "$deb" ] || continue
  dpkg-deb -f "$d" Depends | grep -qF "jarvis-shell (= $old)" || continue
  "$here/repack-version.sh" "$d" "$(dpkg-deb -f "$d" Version)+update1" "$tmp/debs" "jarvis-shell=$version" >/dev/null
done
fpr=$(gpg --homedir "$gh" --with-colons --list-secret-keys | awk -F: '/^fpr/ {print $10; exit}')
"$here/build-repo.sh" --suite trixie --debs "$tmp/debs" --out "$out/good" --gnupghome "$gh" --sign-with "$fpr" >/dev/null
rogue=$("$here/test-key.sh" "$tmp/rogue-gnupg")
"$here/build-repo.sh" --suite trixie --debs "$tmp/debs" --out "$out/rogue" --gnupghome "$tmp/rogue-gnupg" --sign-with "$rogue" >/dev/null
echo "$version"
