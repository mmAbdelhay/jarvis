#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../lib/stage-cmake.sh
. "$(dirname "$0")/../lib/stage-cmake.sh"
stage_cmake "$1" "${UI_BUILD_DIR:-$REPO_ROOT/os/ui/build}" \
  "${UI_RUNTIME_DEPS:-$REPO_ROOT/os/ui/deps/debian-runtime.txt}" \
  "cmake -S os/ui -B os/ui/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && cmake --build os/ui/build" \
  usr/lib/x86_64-linux-gnu/qt6/qml/Jarvis/UI/qmldir
