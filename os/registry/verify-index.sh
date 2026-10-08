#!/usr/bin/env bash
# verify-index.sh --keyring KEYRING.gpg --site DIR --channel stable|testing
# What a client does before trusting the registry: gpgv with only the archive
# keyring, then the index schema (os/registry/schema.py).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
keyring="" site="" channel=""
while [ $# -gt 0 ]; do
  case $1 in
    --keyring) keyring=$2; shift 2 ;;
    --site) site=$2; shift 2 ;;
    --channel) channel=$2; shift 2 ;;
    *) echo "verify-index: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "verify-index: $*" >&2; exit 1; }
case $channel in stable) dir=registry ;; testing) dir=registry-testing ;; *) die "--channel must be stable or testing" ;; esac
[ -f "$keyring" ] || die "no keyring at $keyring"
keyring=$(cd "$(dirname "$keyring")" && pwd)/$(basename "$keyring")   # gpgv reads bare names from GNUPGHOME
idx=$site/$dir/index.json
[ -f "$idx" ] && [ -f "$idx.sig" ] || die "need $idx and $idx.sig"
gpgv --keyring "$keyring" "$idx.sig" "$idx" 2>/dev/null || die "bad or foreign signature on $idx"
python3 "$here/schema.py" check-index "$idx" >/dev/null || die "signed index fails the schema"
echo "verify-index: ok ($idx)"
