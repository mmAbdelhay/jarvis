#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../lib/stage-cmake.sh
. "$here/../lib/stage-cmake.sh"
stage_cmake "$1" "${GREETER_BUILD_DIR:-$REPO_ROOT/os/greeter/build}" \
  "${GREETER_RUNTIME_DEPS:-$REPO_ROOT/os/greeter/deps/debian-runtime.txt}" \
  "cmake -S os/greeter -B os/greeter/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && cmake --build os/greeter/build" \
  usr/bin/jarvis-greeter
# Ours (contracts §7): greetd runs the greeter in cage. A template, not a
# conffile: postinst puts it at greetd's (diverted) path, see preinst.
install -D -m0644 "$here/config.toml" "$1/usr/share/jarvis-greeter/greetd-config.toml"
install -D -m0755 "$here/with-keyboard" "$1/usr/lib/jarvis-greeter/with-keyboard"
