#!/usr/bin/env bash
# Linux CI entry for jarvis-lock; Plan P calls it from the os workflow.
# Requires: repo root as cwd; the packages in os/lock/deps/debian-build.txt.
set -euo pipefail

cmake -S os/lock -B os/lock/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/lock/build
QT_QPA_PLATFORM=offscreen ctest --test-dir os/lock/build --output-on-failure
# Real PAM must have been exercised on Linux (pam_wrapper present).
ctest --test-dir os/lock/build -N -L pam | grep -q tst_pam

rm -rf os/lock/build/stage
DESTDIR="$PWD/os/lock/build/stage" cmake --install os/lock/build
test -f os/lock/build/stage/etc/pam.d/jarvis-lock
test -z "$(find os/lock/build/stage -path '*Jarvis/UI*' -print -quit)" # jarvis-ui ships separately
test -x os/lock/build/stage/usr/bin/jarvis-lock
test -f os/lock/build/stage/usr/share/jarvis/i18n/jarvis-lock_ar.qm
test ! -e os/lock/build/stage/usr/bin/jarvis-lock-testhooks
# Positive control: the marker must be findable in the hook build, else this check is vacuous.
grep -a -q -- 'JARVIS_LOCK_TEST_HOOKS_PRESENT' os/lock/build/src/jarvis-lock-testhooks || {
  echo "jarvis-lock: test-hook marker missing from jarvis-lock-testhooks (check is vacuous)" >&2
  exit 1
}
if grep -a -q -- 'JARVIS_LOCK_TEST_HOOKS_PRESENT' os/lock/build/stage/usr/bin/jarvis-lock; then
  echo "jarvis-lock: the installed binary contains test hooks" >&2
  exit 1
fi
echo "jarvis-lock: build, tests and install layout OK"
os/lock/ci/session-test.sh
