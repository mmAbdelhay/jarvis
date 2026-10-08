# APT repository (`mmAbdelhay/jarvis-apt`)

CI builds the signed APT repository with `build-repo.sh` and publishes it to
GitHub Pages of the separate repo `mmAbdelhay/jarvis-apt`
(https://mmabdelhay.github.io/jarvis-apt). Suites: `trixie` (each `os-v*`
tag) and `trixie-testing` (each push to `master`). Installed systems read it
through `/etc/apt/sources.list.d/jarvis.sources` from `jarvis-archive-keyring`.

## One-time key setup (owner only, on your own machine)

Automation never creates this key. Do it once, offline if you can.

```bash
export GNUPGHOME=$(mktemp -d)        # a fresh, private keyring
gpg --quick-generate-key "Rafiq Archive Signing Key <mm.abdelhay2015@gmail.com>" ed25519 sign 3y
FPR=$(gpg --with-colons --list-keys | awk -F: '/^fpr/ {print $10; exit}')
gpg --armor --export "$FPR" > os/repo/keys/jarvis-archive-keyring.asc   # PUBLIC key: commit it
echo "$FPR" > os/repo/keys/FINGERPRINT                                  # commit it
gpg --armor --export-secret-keys "$FPR" | gh secret set JARVIS_APT_SIGNING_KEY --repo mmAbdelhay/jarvis
gpg --armor --export-secret-keys "$FPR" > ~/rafiq-archive-key.secret.asc # offline backup: USB, password manager
```

The CI key has no passphrase because it lives only in the GitHub secret. Keep
the backup off this repository and off cloud sync. Then commit the two public
files in a PR; CI's keyring package now carries the real key.

## Pages repo setup

1. Create the public repo `mmAbdelhay/jarvis-apt` (empty, default branch `main`).
2. Settings -> Pages -> Deploy from branch `main`, folder `/`.
3. Make a deploy key: `ssh-keygen -t ed25519 -N '' -f /tmp/jarvis-apt-deploy`.
   Add `/tmp/jarvis-apt-deploy.pub` to `jarvis-apt` -> Settings -> Deploy keys,
   **Allow write access**. Then
   `gh secret set JARVIS_APT_DEPLOY_KEY --repo mmAbdelhay/jarvis < /tmp/jarvis-apt-deploy`
   and delete both files.

## What CI does without the secrets

- No `JARVIS_APT_SIGNING_KEY` or no `JARVIS_APT_DEPLOY_KEY`: the `repo` job
  prints a warning and stops. Nothing is published.
- No committed public key: `jarvis-archive-keyring` is built from a throwaway
  key generated in the run (`test-key.sh`, uid "NOT FOR RELEASE"), so tests
  still verify signatures end to end. An `os-v*` tag build fails instead.

## Rotating or revoking the key

1. Make the new key as above; commit the new `.asc` + `FINGERPRINT` together
   with a `jarvis-archive-keyring` that holds BOTH keys
   (`cat old.asc new.asc > keys/jarvis-archive-keyring.asc`) and keep signing
   with the old key until that keyring version reached `trixie`.
2. Switch `JARVIS_APT_SIGNING_KEY` to the new key; next release drops the old key.
3. If the private key leaked: revoke it (`gpg --gen-revoke`), publish a keyring
   without it in a release signed by the new key, and rotate the secret now.

## Local commands

```bash
TRIXIE_PACKAGES="gpg reprepro git" os/packaging/dev/trixie.sh os/repo/tests/run.sh
```
