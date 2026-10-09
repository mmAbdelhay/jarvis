#!/usr/bin/env bash
# Repo tests. Linux, needs gpg, reprepro, dpkg-dev, apt, git. On macOS:
#   TRIXIE_PACKAGES="gpg reprepro git" os/packaging/dev/trixie.sh os/repo/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")"
status=0
for t in test-*.sh; do echo "== $t"; bash "$t" || status=1; done
exit "$status"
