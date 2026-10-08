#!/usr/bin/env bash
# Linux CI entry for jarvis-ui (QML module Jarvis.UI); Plan H calls it from .github/workflows/os*.yml.
# Requires: repo root as cwd; the packages in os/ui/deps/debian-build.txt.
set -euo pipefail

cmake -S os/ui -B os/ui/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/ui/build
QT_QPA_PLATFORM=offscreen ctest --test-dir os/ui/build --output-on-failure

rm -rf os/ui/build/stage
DESTDIR="$PWD/os/ui/build/stage" cmake --install os/ui/build
dir=os/ui/build/stage/usr/lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI   # contracts §7
test -f "$dir/qmldir"
test -f "$dir/jarvis_ui.qmltypes"
test -f "$dir/libjarvis_ui.so"
grep -qx 'module Jarvis.UI' "$dir/qmldir"
echo "jarvis-ui: build, tests and install layout OK"
