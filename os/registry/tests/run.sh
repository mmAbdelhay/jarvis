#!/usr/bin/env bash
# Shell tests for os/registry. Linux; needs file, busybox-static, gpg, gpgv,
# python3. On macOS:
#   TRIXIE_PACKAGES="busybox-static gpg gpgv" os/packaging/dev/trixie.sh os/registry/tests/run.sh
# Python tests: python3 -m unittest discover -s os/registry/tests -v
set -euo pipefail
cd "$(dirname "$0")"
status=0
for t in test-*.sh; do echo "== $t"; bash "$t" || status=1; done
exit "$status"
