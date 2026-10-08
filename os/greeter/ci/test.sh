#!/usr/bin/env bash
# Linux CI entry for jarvis-greeter; Plan H calls it. Requires: repo root as cwd,
# the packages in os/greeter/deps/debian-build.txt.
set -euo pipefail

cmake -S os/greeter -B os/greeter/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/greeter/build
QT_QPA_PLATFORM=offscreen ctest --test-dir os/greeter/build --output-on-failure

rm -rf os/greeter/build/stage
DESTDIR="$PWD/os/greeter/build/stage" cmake --install os/greeter/build
test -x os/greeter/build/stage/usr/bin/jarvis-greeter
test -f os/greeter/build/stage/usr/share/jarvis/i18n/jarvis-greeter_ar.qm
test -z "$(find os/greeter/build/stage -path '*Jarvis/UI*' -print -quit)" # jarvis-ui ships separately
echo "jarvis-greeter: build, tests and install layout OK"
