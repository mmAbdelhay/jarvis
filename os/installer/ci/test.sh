#!/usr/bin/env bash
# Linux CI entry for jarvis-installer; Plan H calls it. Requires: repo root as cwd,
# the packages in os/installer/deps/debian-build.txt (incl. dbus-daemon for the D-Bus test).
set -euo pipefail

cmake -S os/installer -B os/installer/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/installer/build
QT_QPA_PLATFORM=offscreen ctest --test-dir os/installer/build --output-on-failure
test "$(ctest --test-dir os/installer/build -N -L dbus | grep -c tst_dbusbackend)" -ge 1 # the D-Bus client test was built

rm -rf os/installer/build/stage
DESTDIR="$PWD/os/installer/build/stage" cmake --install os/installer/build
test -x os/installer/build/stage/usr/bin/jarvis-installer
test -f os/installer/build/stage/usr/share/applications/jarvis-installer.desktop
if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate os/installer/build/stage/usr/share/applications/jarvis-installer.desktop
fi
test -z "$(find os/installer/build/stage -path '*Jarvis/UI*' -print -quit)" # jarvis-ui ships separately
test -f os/installer/build/stage/usr/share/jarvis/i18n/jarvis-installer_ar.qm
echo "jarvis-installer: build, tests and install layout OK"
