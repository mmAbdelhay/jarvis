#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../lib/stage-lib.sh
. "$(dirname "$0")/../lib/stage-lib.sh"
dist=${GO_DIST:-$REPO_ROOT/os/go/dist}
# shellcheck disable=SC2034
TAKE_HINT="make -C os/go dist (M2 contracts §5, §7)"
take "$dist" "$1" 0755 usr/libexec/jarvis/jarvis-model-fetch
take "$dist" "$1" 0644 usr/lib/systemd/system/jarvis-model-fetch.service
