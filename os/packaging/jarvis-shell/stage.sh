#!/usr/bin/env bash
# Stage jarvis-shell with Plan C's own CMake install rules, and take its
# runtime package list (QML modules, fonts, foot) from Plan C's file, so the
# package Depends match it by construction (contracts §6 #18).
set -euo pipefail
# shellcheck source=../lib/stage-cmake.sh
. "$(dirname "$0")/../lib/stage-cmake.sh"
stage=$1
build=${SHELL_BUILD_DIR:-$REPO_ROOT/os/shell/build}
runtime=${SHELL_RUNTIME_DEPS:-$REPO_ROOT/os/shell/deps/debian-runtime.txt}
if [ ! -f "$build/CMakeCache.txt" ]; then
  echo "jarvis-shell: no CMake build at $build" >&2
  echo "  cmake -S os/shell -B os/shell/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr" >&2
  echo "  cmake --build os/shell/build   (or os/shell/ci/test.sh)" >&2
  exit 1
fi
if [ ! -f "$runtime" ]; then
  echo "jarvis-shell: no runtime package list at $runtime (os/shell/deps/debian-runtime.txt, Plan C)" >&2
  exit 1
fi
DESTDIR=$stage cmake --install "$build" --prefix /usr >/dev/null
drop_shared_translations "$stage"
for path in usr/bin/jarvis-shell usr/share/jarvis-shell/labwc/rc.xml usr/share/jarvis-shell/labwc/autostart; do
  if [ ! -e "$stage/$path" ]; then
    echo "jarvis-shell: cmake --install did not produce /$path (contracts §4, §6 #18)" >&2
    exit 1
  fi
done
cp "$runtime" "$stage/.extra-depends"
