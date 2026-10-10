#!/usr/bin/env bash
# Stage jarvis-cu (v1.1 contracts §1): Plan U's helper from `make -C os/go dist`,
# plus Plan X's user unit and labwc autostart fragment. Contracts §4.6 has U
# produce the unit in os/go/dist and X package it; X ships its own, stricter
# copy instead (UMask, ConditionEnvironment, ExecCondition, RestrictNamespaces),
# a deliberate deviation. U's file may differ in hardening, but not in what the
# unit runs or what it can reach: ExecStart and RestrictAddressFamilies must
# match, or the build stops.
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
key() { grep -E "^$2=" "$1" | tr -s ' ' || true; }
if [ -e "$theirs" ]; then
  for k in ExecStart RestrictAddressFamilies; do
    if [ "$(key "$theirs" "$k")" != "$(key "$here/jarvis-cu.service" "$k")" ]; then
      echo "jarvis-cu: $theirs and os/packaging/jarvis-cu/jarvis-cu.service differ in $k." >&2
      echo "  Plan U's unit and Plan X's unit must run and confine the same way. Reconcile them." >&2
      exit 1
    fi
  done
fi
install -D -m0644 "$here/jarvis-cu.service" "$stage/usr/lib/systemd/user/jarvis-cu.service"
install -D -m0644 "$here/labwc-autostart" "$stage/usr/share/jarvis-cu/labwc/autostart"
