#!/usr/bin/env bash
# release-guard.sh CHROOT BINARY [--release KEYS_DIR] — fail if the image could turn on the fake
# provider (contracts §5) or a debug shell. jarvisd itself reads the
# variable, so /usr/lib/jarvis/daemon is the one place it may appear. The
# smoke harness adds its debug shell on its own kernel command line; the
# boot menu shipped in the ISO must never carry one.
set -euo pipefail
chroot=$1
binary=$2
release_keys=""
if [ "${3:-}" = --release ]; then release_keys=${4:?--release needs KEYS_DIR}; fi
problems=0

hits=$(find "$chroot" \( -path "$chroot/proc" -o -path "$chroot/sys" -o -path "$chroot/dev" \
  -o -path "$chroot/run" -o -path "$chroot/usr/lib/jarvis/daemon" \) -prune -o -type f -print0 |
  xargs -0 -r grep -lI -e JARVIS_FAKE_PROVIDER -- 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "release-guard: JARVIS_FAKE_PROVIDER appears outside jarvisd:" >&2
  # shellcheck disable=SC2086
  printf '  %s\n' $hits >&2
  problems=1
fi

menus=$(find "$binary/boot/grub" -type f -name '*.cfg' 2>/dev/null || true)
# shellcheck disable=SC2086
if [ -n "$menus" ] && grep -lE 'debug_shell|JARVIS_' $menus >/dev/null 2>&1; then
  echo "release-guard: a boot menu enables a debug shell or a JARVIS_ switch:" >&2
  # shellcheck disable=SC2086
  grep -nE 'debug_shell|JARVIS_' $menus >&2 || true
  problems=1
fi

if [ -n "$release_keys" ]; then
  kr=$chroot/usr/share/keyrings/jarvis-archive-keyring.gpg
  tmpg=$(mktemp -d); trap 'rm -rf "$tmpg"' EXIT
  info=$(gpg --homedir "$tmpg" --show-keys --with-colons "$kr" 2>/dev/null || true)
  have=$(awk -F: '/^fpr/ {print $10; exit}' <<<"$info")
  want=$(tr -d '[:space:]' < "$release_keys/FINGERPRINT" 2>/dev/null | tr '[:lower:]' '[:upper:]' || true)
  if [ -z "$want" ]; then
    echo "release-guard: no committed $release_keys/FINGERPRINT (owner runbook os/repo/README.md)" >&2; problems=1
  elif [ "$have" != "$want" ]; then
    echo "release-guard: archive keyring is ${have:-<none>}, release key is $want" >&2; problems=1
  fi
  if grep -q 'NOT FOR RELEASE' <<<"$info"; then
    echo "release-guard: the archive keyring holds a throwaway CI key" >&2; problems=1
  fi
fi

exit "$problems"
