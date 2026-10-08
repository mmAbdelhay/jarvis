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
echo "jarvis-lock: build, tests and install layout OK"
