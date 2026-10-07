#!/usr/bin/env bash
# Throwaway and secret-key tooling. No real key is ever generated here.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
g=$tmp/gnupg; mkdir -m700 "$g"
fpr=$("$REPO_DIR/test-key.sh" "$g")
check "fingerprint printed" grep -Eqx '[0-9A-F]{40}' <<<"$fpr"
check "public key exported" grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$g/pubkey.asc"
info=$(gpg --homedir "$g" --with-colons --list-keys "$fpr")
check "ed25519" grep -q '^pub:[^:]*:255:22:' <<<"$info"
check "uid says not for release" grep -q 'NOT FOR RELEASE' <<<"$info"
check "expires" bash -c "awk -F: '/^pub/ {exit (\$7 == \"\")}' <<<\"\$1\"" _ "$info"
check "refused on release tags" bash -c "! GITHUB_REF=refs/tags/os-v0.2.0 '$REPO_DIR/test-key.sh' '$tmp/g2' 2>/dev/null"

# import-key.sh against a fake committed FINGERPRINT (the throwaway's).
armored=$(gpg --homedir "$g" --armor --export-secret-keys "$fpr")
mkdir -p "$tmp/keys"; echo "$fpr" > "$tmp/keys/FINGERPRINT"
out=$(JARVIS_REPO_KEYS_DIR=$tmp/keys JARVIS_APT_SIGNING_KEY=$armored "$REPO_DIR/import-key.sh" "$tmp/g3" 2>&1)
check "import accepts the matching key" test "$out" = "$fpr"
check "import never echoes key material" bash -c "! grep -q 'PRIVATE KEY' <<<\"\$1\"" _ "$out"
echo 0000000000000000000000000000000000000000 > "$tmp/keys/FINGERPRINT"
check "import refuses a fingerprint mismatch" bash -c "! JARVIS_REPO_KEYS_DIR='$tmp/keys' JARVIS_APT_SIGNING_KEY=\"\$1\" '$REPO_DIR/import-key.sh' '$tmp/g4' 2>/dev/null" _ "$armored"
check "import refuses an empty secret" bash -c "! JARVIS_REPO_KEYS_DIR='$tmp/keys' JARVIS_APT_SIGNING_KEY= '$REPO_DIR/import-key.sh' '$tmp/g5' 2>/dev/null"
check "no private key committed anywhere in os/" bash -c "! git -C '$REPO_ROOT' grep -l 'PRIVATE KEY BLOCK' -- os ':!os/repo/tests' >/dev/null"
# Reject bundles even when their first key matches the pinned fingerprint.
echo "$fpr" > "$tmp/keys/FINGERPRINT"
gpg --homedir "$g" --batch --quiet --pinentry-mode loopback --passphrase '' \
  --quick-generate-key 'Second test key (NOT FOR RELEASE) <second@invalid>' ed25519 sign 2d
bundle=$(gpg --homedir "$g" --armor --export-secret-keys)
check "import refuses multiple keys" bash -c '! JARVIS_REPO_KEYS_DIR="$1" JARVIS_APT_SIGNING_KEY="$2" "$3" "$4" >/dev/null 2>&1' _ "$tmp/keys" "$bundle" "$REPO_DIR/import-key.sh" "$tmp/multiple"
gpg --homedir "$g" --batch --quiet --pinentry-mode loopback --passphrase '' \
  --quick-generate-key 'Certification test key (NOT FOR RELEASE) <cert@invalid>' ed25519 cert 2d
cert_fpr=$(gpg --homedir "$g" --with-colons --list-keys cert@invalid | awk -F: '/^fpr/ {print $10; exit}')
cert_secret=$(gpg --homedir "$g" --armor --export-secret-keys "$cert_fpr")
echo "$cert_fpr" > "$tmp/keys/FINGERPRINT"
check "import refuses a key without signing capability" bash -c '! JARVIS_REPO_KEYS_DIR="$1" JARVIS_APT_SIGNING_KEY="$2" "$3" "$4" >/dev/null 2>&1' _ "$tmp/keys" "$cert_secret" "$REPO_DIR/import-key.sh" "$tmp/cert"
finish
