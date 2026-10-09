#!/usr/bin/env bash
# Stage jarvisd: Plan A's single-file bundle with its map, build stamp and
# user unit (contracts §6 #16, #6), plus the pinned Node 24 runtime.
set -euo pipefail
stage=$1
here=$(cd "$(dirname "$0")" && pwd)
dist=${DAEMON_DIST:-$REPO_ROOT/packages/desktop/dist-daemon}
TAKE_HINT="pnpm --filter @jarvis/desktop build:daemon (contracts §6 #16)"
exec_line='ExecStart=/usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run'

stage_from() { # stage_from DIST_FILE MODE INSTALL_PATH
  if [ ! -f "$dist/$1" ]; then
    echo "jarvisd: missing $dist/$1" >&2
    echo "  produced by: $TAKE_HINT" >&2
    exit 1
  fi
  install -D -m "$2" "$dist/$1" "$stage/$3"
}
stage_from jarvisd.mjs 0644 usr/lib/jarvis/daemon/jarvisd.mjs
stage_from jarvisd.mjs.map 0644 usr/lib/jarvis/daemon/jarvisd.mjs.map
stage_from build-stamp.json 0644 usr/lib/jarvis/daemon/build-stamp.json
stage_from jarvisd.service 0644 usr/lib/systemd/user/jarvisd.service

unit=$stage/usr/lib/systemd/user/jarvisd.service
if ! grep -qx "$exec_line" "$unit"; then
  echo "jarvisd: $dist/jarvisd.service must contain exactly:" >&2
  echo "  $exec_line" >&2
  grep -n '^ExecStart' "$unit" >&2 || true
  exit 1
fi
if grep -q JARVIS_FAKE_PROVIDER "$unit"; then
  echo "jarvisd: the shipped unit must never set JARVIS_FAKE_PROVIDER (contracts §5)" >&2
  exit 1
fi

"$here/../lib/fetch-node.sh" "$stage/usr/lib/jarvis/node"
node_version=$("$stage/usr/lib/jarvis/node/bin/node" --version)
case $node_version in
  v24.*) ;;
  *) echo "jarvisd: bundled node is $node_version, need v24" >&2; exit 1 ;;
esac
