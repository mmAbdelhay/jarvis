#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../lib/stage-cmake.sh
. "$(dirname "$0")/../lib/stage-cmake.sh"
stage_cmake "$1" "${INSTALLER_BUILD_DIR:-$REPO_ROOT/os/installer/build}" \
  "${INSTALLER_RUNTIME_DEPS:-$REPO_ROOT/os/installer/deps/debian-runtime.txt}" \
  "cmake -S os/installer -B os/installer/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && cmake --build os/installer/build" \
  usr/bin/jarvis-installer usr/share/applications/jarvis-installer.desktop
