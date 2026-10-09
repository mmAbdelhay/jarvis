#!/usr/bin/env bash
# Linux CI entry for jarvis-idle; Plan P calls it from the os workflow.
# Requires: repo root as cwd; the packages in os/idle/deps/debian-build.txt.
set -euo pipefail

cmake -S os/idle -B os/idle/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/idle/build
ctest --test-dir os/idle/build --output-on-failure
rm -rf os/idle/build/stage
DESTDIR="$PWD/os/idle/build/stage" cmake --install os/idle/build
test -x os/idle/build/stage/usr/libexec/jarvis/jarvis-idle
test -f os/idle/build/stage/usr/share/jarvis-idle/labwc/autostart
test ! -e os/idle/build/stage/usr/libexec/jarvis/jarvis-idle-testhooks
# Positive control: the marker must be findable in the hook build, else this check is vacuous.
grep -a -q -- 'JARVIS_IDLE_TEST_HOOKS_PRESENT' os/idle/build/src/jarvis-idle-testhooks || {
  echo "jarvis-idle: test-hook marker missing from jarvis-idle-testhooks (check is vacuous)" >&2
  exit 1
}
if grep -a -q -- 'JARVIS_IDLE_TEST_HOOKS_PRESENT' os/idle/build/stage/usr/libexec/jarvis/jarvis-idle; then
  echo "jarvis-idle: the installed binary contains test hooks" >&2
  exit 1
fi
echo "jarvis-idle: build, tests and install layout OK"
os/idle/ci/session-test.sh
