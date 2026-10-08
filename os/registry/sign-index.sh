#!/usr/bin/env bash
# sign-index.sh --site DIR --channel stable|testing --gnupghome DIR --sign-with FPR
# Detached binary OpenPGP signature SITE/<dir>/index.json.sig by the APT repo
# key (M2.5 contracts §3), then checked with gpgv against that key alone.
# A release (JARVIS_RELEASE=1) refuses a throwaway "NOT FOR RELEASE" key.
set -euo pipefail
site="" channel="" gh="" sign=""
while [ $# -gt 0 ]; do
  case $1 in
    --site) site=$2; shift 2 ;;
    --channel) channel=$2; shift 2 ;;
    --gnupghome) gh=$2; shift 2 ;;
    --sign-with) sign=$2; shift 2 ;;
    *) echo "sign-index: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "sign-index: $*" >&2; exit 1; }
case $channel in stable) dir=registry ;; testing) dir=registry-testing ;; *) die "--channel must be stable or testing" ;; esac
[ -n "$gh" ] && [ -n "$sign" ] || die "--gnupghome and --sign-with are required"
idx=$site/$dir/index.json
[ -f "$idx" ] || die "no $idx (run build_index.py first)"
export GNUPGHOME=$gh
if [ "${JARVIS_RELEASE:-0}" = 1 ] && gpg --with-colons --list-keys "$sign" 2>/dev/null | grep -q 'NOT FOR RELEASE'; then
  die "refusing to sign a release registry with a throwaway key"
fi
rm -f "$idx.sig"
gpg --batch --yes --quiet --local-user "$sign!" --detach-sign --output "$idx.sig" "$idx"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
gpg --export "$sign" > "$tmp/key.gpg"
gpgv --keyring "$tmp/key.gpg" "$idx.sig" "$idx" 2>/dev/null || die "the new signature does not verify"
echo "$idx.sig"
