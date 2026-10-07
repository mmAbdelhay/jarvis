#!/usr/bin/env bash
# Runs every packaging test. Linux only (dpkg-deb); on macOS:
#   TRIXIE_PACKAGES="cmake gcc libc6-dev" os/packaging/dev/trixie.sh os/packaging/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")"
status=0
for t in test-*.sh; do
  echo "== $t"
  bash "$t" || status=1
done
exit "$status"
