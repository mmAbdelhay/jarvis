#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../lib/stage-lib.sh
. "$(dirname "$0")/../lib/stage-lib.sh"
dist=${GO_DIST:-$REPO_ROOT/os/go/dist}
# shellcheck disable=SC2034  # read by take() in stage-lib.sh
TAKE_HINT="make -C os/go dist (contracts §2)"
take "$dist" "$1" 0755 usr/libexec/jarvis/jarvis-helper
take "$dist" "$1" 0644 usr/share/dbus-1/system.d/os.jarvis.Helper1.conf
take "$dist" "$1" 0644 usr/share/dbus-1/system-services/os.jarvis.Helper1.service
take "$dist" "$1" 0644 usr/lib/systemd/system/jarvis-helper.service
take "$dist" "$1" 0644 usr/share/polkit-1/actions/os.jarvis.helper.policy
# Ours, not Plan B's (contracts §6 #19).
install -D -m0644 "$(dirname "$0")/50-jarvis.rules" "$1/usr/share/polkit-1/rules.d/50-jarvis.rules"
# Admin passwords are verified by the helper, outside the login session.
install -D -m0644 "$(dirname "$0")/jarvis-admin.pam" "$1/etc/pam.d/jarvis-admin"
