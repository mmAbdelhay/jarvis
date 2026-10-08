#!/usr/bin/env bash
# jarvis-agent is a metapackage: its dependencies are the product. It ships
# only the README that explains the one manual step (jarvis-admins).
set -euo pipefail
install -D -m0644 "$(dirname "$0")/README.Debian" "$1/usr/share/doc/jarvis-agent/README.Debian"
