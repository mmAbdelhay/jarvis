#!/usr/bin/env bash
# Stage jarvis-cu (v1.1 contracts §1): Plan U's helper from `make -C os/go dist`,
# plus Plan X's user unit and labwc autostart fragment. The unit has one owner
# (gap G4): a different jarvis-cu.service in os/go/dist stops the build.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
stage=$1
# shellcheck source=../lib/stage-lib.sh
. "$here/../lib/stage-lib.sh"
dist=${GO_DIST:-$REPO_ROOT/os/go/dist}
# shellcheck disable=SC2034  # read by take() in stage-lib.sh
TAKE_HINT="make -C os/go dist (v1.1 contracts §1, Plan U)"
take "$dist" "$stage" 0755 usr/libexec/jarvis/jarvis-cu
theirs=$dist/usr/lib/systemd/user/jarvis-cu.service
if [ -e "$theirs" ] && ! cmp -s "$theirs" "$here/jarvis-cu.service"; then
  echo "jarvis-cu: $theirs differs from os/packaging/jarvis-cu/jarvis-cu.service." >&2
  echo "  Plan X packages its own unit (v1.1 Plan X gap G4). Reconcile them." >&2
  exit 1
fi
install -D -m0644 "$here/jarvis-cu.service" "$stage/usr/lib/systemd/user/jarvis-cu.service"
install -D -m0644 "$here/labwc-autostart" "$stage/usr/share/jarvis-cu/labwc/autostart"
