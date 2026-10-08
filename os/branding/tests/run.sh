#!/usr/bin/env bash
# Every branding test. test-render/test-plymouth/test-grub need rsvg-convert,
# grub-mkfont and fonts-inter (Linux): on macOS run through
#   TRIXIE_PACKAGES="librsvg2-bin grub-common fonts-inter" os/packaging/dev/trixie.sh os/branding/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")"
status=0
for t in test-*.sh; do
  echo "== $t"
  bash "$t" || status=1
done
exit "$status"
