#!/usr/bin/env bash
# Stage jarvis-lock: Plan O's lock screen (its CMake install rules and runtime
# package list) and our PAM service (M3 contracts §3).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
stage=$1
# shellcheck source=../lib/stage-cmake.sh
. "$here/../lib/stage-cmake.sh"
stage_cmake "$stage" "${LOCK_BUILD_DIR:-$REPO_ROOT/os/lock/build}" \
  "${LOCK_RUNTIME_DEPS:-$REPO_ROOT/os/lock/deps/debian-runtime.txt}" \
  "cmake -S os/lock -B os/lock/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && cmake --build os/lock/build (or os/lock/ci/test.sh)" \
  usr/bin/jarvis-lock
bin=$stage/usr/bin/jarvis-lock
# jarvisd accepts sys:setLocked only from a peer whose /proc/<pid>/exe is
# /usr/bin/jarvis-lock (contracts §3). A script or symlink there would make
# the kernel report the interpreter or the target instead.
if [ -L "$bin" ] || [ "$(head -c 4 "$bin" | od -An -tx1 | tr -d ' \n')" != 7f454c46 ]; then
  echo "jarvis-lock: /usr/bin/jarvis-lock must be the ELF program itself, not a script or symlink:" >&2
  echo "  jarvisd checks the lock client's /proc/<pid>/exe (M3 contracts §3)" >&2
  exit 1
fi
# Never setuid/setgid: the lock UI runs as the user; PAM uses unix_chkpwd.
chmod 0755 "$bin"
install -D -m0644 "$here/pam" "$stage/etc/pam.d/jarvis-lock"
