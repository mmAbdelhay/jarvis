#!/usr/bin/env bash
# Static and script tests for os/iso. Needs bash, python3 (3.11+), and for
# test-build-scripts.sh dpkg-deb: run through os/packaging/dev/trixie.sh on macOS.
set -euo pipefail
cd "$(dirname "$0")"
status=0
for t in test-*.sh; do
  echo "== $t"
  bash "$t" || status=1
done
exit "$status"
