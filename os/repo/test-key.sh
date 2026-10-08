#!/usr/bin/env bash
# test-key.sh GNUPGHOME — a THROWAWAY Ed25519 signing key for CI and tests:
# no passphrase, expires in 2 days, uid says NOT FOR RELEASE. Prints its
# fingerprint; writes GNUPGHOME/pubkey.asc. Never for a release.
set -euo pipefail
home=$1
case ${GITHUB_REF:-} in
  refs/tags/os-v*) echo "test-key: refusing to make a throwaway key for a release build" >&2; exit 1 ;;
esac
mkdir -p "$home"; chmod 700 "$home"
export GNUPGHOME=$home
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key \
  'CI throwaway key (NOT FOR RELEASE) <ci@invalid>' ed25519 sign 2d
fpr=$(gpg --with-colons --list-keys 'NOT FOR RELEASE' | awk -F: '/^fpr/ {print $10; exit}')
gpg --armor --export "$fpr" > "$home/pubkey.asc"
echo "$fpr"
