#!/usr/bin/env bash
# Stage jarvis-branding from os/branding/render.sh (contracts §7).
set -euo pipefail
"$REPO_ROOT/os/branding/render.sh" "$1" >/dev/null
