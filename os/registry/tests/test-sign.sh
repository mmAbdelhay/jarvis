#!/usr/bin/env bash
# sign-index.sh / verify-index.sh with throwaway keys only (never a real key).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
command -v gpgv >/dev/null || { echo "SKIP test-sign.sh (needs gpg, gpgv)"; exit 0; }
g=$tmp/g; fpr=$("$REPO_ROOT/os/repo/test-key.sh" "$g")
gpg --homedir "$g" --export "$fpr" > "$tmp/archive.gpg"

mkdir -p "$tmp/art"
for id in jarvis-clock jarvis-files jarvis-web; do echo "$id" > "$tmp/art/$id-0.1.0-linux-amd64.tar.gz"; done
python3 "$REG_DIR/build_index.py" --servers "$REG_DIR/servers" --artifacts "$tmp/art" --out "$tmp/site" \
  --channel testing --generated-at 2026-10-09T00:00:00Z >/dev/null
idx=$tmp/site/registry-testing/index.json

sig=$("$REG_DIR/sign-index.sh" --site "$tmp/site" --channel testing --gnupghome "$g" --sign-with "$fpr")
check "signature path" test "$sig" = "$idx.sig"
check "binary, not armored" bash -c "! grep -q 'BEGIN PGP' '$idx.sig'"
check "gpgv accepts it with only the archive keyring" gpgv --keyring "$tmp/archive.gpg" "$idx.sig" "$idx"
check "verify-index accepts" "$REG_DIR/verify-index.sh" --keyring "$tmp/archive.gpg" --site "$tmp/site" --channel testing

cp -a "$tmp/site" "$tmp/tampered"; printf ' ' >> "$tmp/tampered/registry-testing/index.json"
check "tampered index refused" bash -c "! '$REG_DIR/verify-index.sh' --keyring '$tmp/archive.gpg' --site '$tmp/tampered' --channel testing 2>/dev/null"
g2=$tmp/g2; f2=$("$REPO_ROOT/os/repo/test-key.sh" "$g2"); gpg --homedir "$g2" --export "$f2" > "$tmp/other.gpg"
check "another key refused" bash -c "! '$REG_DIR/verify-index.sh' --keyring '$tmp/other.gpg' --site '$tmp/site' --channel testing 2>/dev/null"
check "missing signature refused" bash -c "rm -f '$tmp/tampered/registry-testing/index.json.sig'; ! '$REG_DIR/verify-index.sh' --keyring '$tmp/archive.gpg' --site '$tmp/tampered' --channel testing 2>/dev/null"

# A validly signed but schema-invalid index is still refused.
mkdir -p "$tmp/bad/registry"
echo '{"version": 1, "generatedAt": "2026-10-09T00:00:00Z", "entries": [{"id": "x"}]}' > "$tmp/bad/registry/index.json"
"$REG_DIR/sign-index.sh" --site "$tmp/bad" --channel stable --gnupghome "$g" --sign-with "$fpr" >/dev/null
check "signed garbage refused" bash -c "! '$REG_DIR/verify-index.sh' --keyring '$tmp/archive.gpg' --site '$tmp/bad' --channel stable 2>/dev/null"

check "release refuses a throwaway key" bash -c "! JARVIS_RELEASE=1 '$REG_DIR/sign-index.sh' --site '$tmp/site' --channel testing --gnupghome '$g' --sign-with '$fpr' 2>/dev/null"
check "no index to sign fails" bash -c "! '$REG_DIR/sign-index.sh' --site '$tmp/none' --channel stable --gnupghome '$g' --sign-with '$fpr' 2>/dev/null"
check "unknown channel fails" bash -c "! '$REG_DIR/sign-index.sh' --site '$tmp/site' --channel beta --gnupghome '$g' --sign-with '$fpr' 2>/dev/null"
check "runbook names the URL, the signature and the keyring" bash -c "grep -q 'jarvis-apt/registry/index.json' '$REG_DIR/README.md' && grep -q 'index.json.sig' '$REG_DIR/README.md' && grep -q 'jarvis-archive-keyring.gpg' '$REG_DIR/README.md'"
check "no private key material in os/registry" bash -c "! grep -rl 'PRIVATE KEY BLOC[K]' '$REG_DIR'"
finish
