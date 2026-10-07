#!/usr/bin/env bash
# Stage the archive keyring and APT source (contracts §7). The public key is
# $JARVIS_ARCHIVE_PUBKEY (CI throwaway) or the owner's committed key, which
# must match the committed FINGERPRINT.
set -euo pipefail
stage=$1
here=$(cd "$(dirname "$0")" && pwd)
keys=${JARVIS_REPO_KEYS_DIR:-$REPO_ROOT/os/repo/keys}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ -n "${JARVIS_ARCHIVE_PUBKEY:-}" ]; then
  src=$JARVIS_ARCHIVE_PUBKEY
elif [ -f "$keys/jarvis-archive-keyring.asc" ]; then
  src=$keys/jarvis-archive-keyring.asc
  [ -f "$keys/FINGERPRINT" ] || { echo "jarvis-archive-keyring: missing FINGERPRINT (see os/repo/README.md)" >&2; exit 1; }
  want=$(tr -d '[:space:]' < "$keys/FINGERPRINT" | tr '[:lower:]' '[:upper:]')
  have=$(gpg --homedir "$tmp" --show-keys --with-colons "$src" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}')
  if [[ ! $want =~ ^[0-9A-F]{40}$ ]] || [ "$have" != "$want" ]; then
    echo "jarvis-archive-keyring: $src is $have, FINGERPRINT says $want" >&2; exit 1
  fi
else
  echo "jarvis-archive-keyring: no public key: set JARVIS_ARCHIVE_PUBKEY or commit" >&2
  echo "  $keys/jarvis-archive-keyring.asc (owner step, os/repo/README.md)" >&2
  exit 1
fi
case ${GITHUB_REF:-} in
  refs/tags/os-v*)
    info=$(gpg --homedir "$tmp" --show-keys --with-colons "$src" 2>/dev/null)
    if grep -q 'NOT FOR RELEASE' <<<"$info"; then
      echo "jarvis-archive-keyring: refusing throwaway keyring for a release build" >&2; exit 1
    fi ;;
esac
mkdir -p "$stage/usr/share/keyrings"
gpg --homedir "$tmp" --dearmor < "$src" > "$stage/usr/share/keyrings/jarvis-archive-keyring.gpg"
chmod 0644 "$stage/usr/share/keyrings/jarvis-archive-keyring.gpg"
install -D -m0644 "$here/jarvis.sources" "$stage/etc/apt/sources.list.d/jarvis.sources"
