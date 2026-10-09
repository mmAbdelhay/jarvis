#!/usr/bin/env bash
# Stage jarvis-classic (M4 contracts §2): Plan R's fallback desktop (taskbar,
# docked chat) with its own CMake install rules and runtime package list.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../lib/stage-cmake.sh
. "$here/../lib/stage-cmake.sh"
stage_cmake "$1" "${CLASSIC_BUILD_DIR:-$REPO_ROOT/os/classic/build}" \
  "${CLASSIC_RUNTIME_DEPS:-$REPO_ROOT/os/classic/deps/debian-runtime.txt}" \
  "cmake -S os/classic -B os/classic/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && cmake --build os/classic/build (or os/classic/ci/test.sh)" \
  usr/bin/jarvis-classic
chmod 0755 "$1/usr/bin/jarvis-classic"
