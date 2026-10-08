#!/usr/bin/env bash
# import-key.sh GNUPGHOME — import the owner's signing key from the CI secret
# JARVIS_APT_SIGNING_KEY (armored private key) and check it is the key whose
# fingerprint is committed in os/repo/keys/FINGERPRINT. Prints the fingerprint.
set -euo pipefail
home=$1
keys=${JARVIS_REPO_KEYS_DIR:-$(cd "$(dirname "$0")" && pwd)/keys}
if [ -z "${JARVIS_APT_SIGNING_KEY:-}" ]; then
  echo "import-key: JARVIS_APT_SIGNING_KEY is empty (see os/repo/README.md)" >&2; exit 1
fi
[ -f "$keys/FINGERPRINT" ] || { echo "import-key: no $keys/FINGERPRINT committed (see os/repo/README.md)" >&2; exit 1; }
want=$(tr -d '[:space:]' < "$keys/FINGERPRINT" | tr '[:lower:]' '[:upper:]')
# Inspect only the supplied secret, independently of keys already in GNUPGHOME.
probe=$(mktemp -d)
trap 'gpgconf --homedir "$probe" --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$probe"' EXIT
chmod 700 "$probe"
if ! printf '%s\n' "$JARVIS_APT_SIGNING_KEY" | gpg --homedir "$probe" --batch --quiet --import 2>/dev/null; then
  echo "import-key: cannot import signing secret" >&2; exit 1
fi
info=$(gpg --homedir "$probe" --with-colons --list-secret-keys 2>/dev/null)
if ! awk -F: '
  /^sec:/ {count++; if ($3 != 255 || $4 != 22 || $12 !~ /s/ || $17 != "ed25519" || $15 != "+") bad=1}
  END {exit (count != 1 || bad)}' <<<"$info"; then
  echo "import-key: requires exactly one Ed25519 signing secret key" >&2; exit 1
fi
have=$(awk -F: '/^fpr/ {print $10; exit}' <<<"$info")
if [[ ! $want =~ ^[0-9A-F]{40}$ ]] || [ "$have" != "$want" ]; then
  echo "import-key: secret key fingerprint ${have:-<none>} != committed $want" >&2; exit 1
fi
mkdir -p "$home"; chmod 700 "$home"
printf '%s\n' "$JARVIS_APT_SIGNING_KEY" | gpg --homedir "$home" --batch --quiet --import 2>/dev/null
echo "$want"
