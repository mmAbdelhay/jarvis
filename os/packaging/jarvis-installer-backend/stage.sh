#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../lib/stage-lib.sh
. "$(dirname "$0")/../lib/stage-lib.sh"
dist=${GO_DIST:-$REPO_ROOT/os/go/dist}
# shellcheck disable=SC2034
TAKE_HINT="make -C os/go dist (M2 contracts §1, §7)"
take "$dist" "$1" 0755 usr/libexec/jarvis/jarvis-installer-backend
take "$dist" "$1" 0644 usr/share/dbus-1/system.d/os.jarvis.Installer1.conf
take "$dist" "$1" 0644 usr/share/dbus-1/system-services/os.jarvis.Installer1.service
take "$dist" "$1" 0644 usr/lib/systemd/system/jarvis-installer-backend.service
take "$dist" "$1" 0644 usr/share/polkit-1/actions/os.jarvis.installer.policy
