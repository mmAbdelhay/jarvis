#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../lib/stage-lib.sh
. "$(dirname "$0")/../lib/stage-lib.sh"
dist=${GO_DIST:-$REPO_ROOT/os/go/dist}
# shellcheck disable=SC2034  # read by take() in stage-lib.sh
TAKE_HINT="make -C os/go dist (M3 contracts §1)"
# The built-in jarvis-files (cmd/jarvis-files-os): the registry server's
# read tools plus the write tools, started by jarvisd outside the sandbox.
take "$dist" "$1" 0755 usr/lib/jarvis/mcp/jarvis-files
