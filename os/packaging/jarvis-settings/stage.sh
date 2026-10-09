#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../lib/stage-lib.sh
. "$(dirname "$0")/../lib/stage-lib.sh"
dist=${GO_DIST:-$REPO_ROOT/os/go/dist}
# shellcheck disable=SC2034  # read by take() in stage-lib.sh
TAKE_HINT="make -C os/go dist (M3 contracts §1)"
take "$dist" "$1" 0755 usr/lib/jarvis/mcp/jarvis-settings
# Ours, not Plan M's (M1 §6 #19 pattern): session-level actions for jarvisd's tools.
install -D -m0644 "$(dirname "$0")/51-jarvis-settings.rules" "$1/usr/share/polkit-1/rules.d/51-jarvis-settings.rules"
