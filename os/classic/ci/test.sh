#!/usr/bin/env bash
# Linux CI entry for jarvis-classic (Rafiq M4 contracts §2); Plan T calls it.
# Requires: repo root as cwd; the packages in os/classic/deps/debian-build.txt.
set -euo pipefail

cmake -S os/classic -B os/classic/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/classic/build
QT_QPA_PLATFORM=offscreen ctest --test-dir os/classic/build --output-on-failure
rm -rf os/classic/build/stage
DESTDIR="$PWD/os/classic/build/stage" cmake --install os/classic/build
stage=os/classic/build/stage
test -x $stage/usr/bin/jarvis-classic
test -f $stage/usr/share/jarvis-classic/labwc/autostart
test -f $stage/usr/share/jarvis-classic/labwc/rc.xml
test -f $stage/usr/share/jarvis/i18n/jarvis-classic_ar.qm
# The shell core is built in, but jarvis-shell ships separately (no binary, no shell files here).
test ! -e $stage/usr/bin/jarvis-shell
test -z "$(find $stage -path '*Jarvis/UI*' -print -quit)"
echo "jarvis-classic: build, tests and install layout OK"
os/classic/ci/session-test.sh
