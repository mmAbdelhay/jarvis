#!/usr/bin/env bash
# Stage jarvis-idle: Plan O's idle daemon (CMake install rules, runtime list),
# our relaunch loop and the labwc autostart fragment (M3 contracts §3).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
stage=$1
# shellcheck source=../lib/stage-cmake.sh
. "$here/../lib/stage-cmake.sh"
stage_cmake "$stage" "${IDLE_BUILD_DIR:-$REPO_ROOT/os/idle/build}" \
  "${IDLE_RUNTIME_DEPS:-$REPO_ROOT/os/idle/deps/debian-runtime.txt}" \
  "cmake -S os/idle -B os/idle/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && cmake --build os/idle/build (or os/idle/ci/test.sh)" \
  usr/libexec/jarvis/jarvis-idle
chmod 0755 "$stage/usr/libexec/jarvis/jarvis-idle"
install -D -m0755 "$here/jarvis-idle-loop" "$stage/usr/libexec/jarvis/jarvis-idle-loop"
install -D -m0644 "$here/labwc-autostart" "$stage/usr/share/jarvis-idle/labwc/autostart"
