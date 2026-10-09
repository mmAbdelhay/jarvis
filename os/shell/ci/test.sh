#!/usr/bin/env bash
# Linux CI entry for jarvis-shell; Plan D calls it from .github/workflows/os.yml.
# Requires (the workflow provides them):
#   - the repo root as cwd;
#   - Node 24 and pnpm on PATH (NOT Debian's nodejs, which is Node 20);
#   - `pnpm install` and `pnpm bootstrap --pty-only` already run;
#   - the packages in os/shell/deps/debian-build.txt installed;
#   - optionally JARVIS_MCP_DIR pointing at Plan B's built MCP servers.
set -euo pipefail

pnpm exec tsc -b                           # packages/*/dist, read by gen-vectors.mjs
pnpm --filter @jarvis/desktop build:daemon # packages/desktop/dist-daemon/jarvisd.mjs (contracts §6.16)
# The C++ port must still match the TypeScript transport byte for byte.
node os/shell/tests/tools/gen-vectors.mjs --check

# contracts §6.18: configure with the /usr prefix, then cmake --install.
cmake -S os/shell -B os/shell/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/shell/build

export QT_QPA_PLATFORM=offscreen
export JARVISD_ENTRY="${JARVISD_ENTRY:-$PWD/packages/desktop/dist-daemon/jarvisd.mjs}"
ctest --test-dir os/shell/build --output-on-failure
# Rafiq v1.1: the overlay test must really run on CI, not be skipped for a missing tool.
ctest --test-dir os/shell/build -N -L wayland | grep -q overlay_wayland \
  || { echo "overlay_wayland not registered: install labwc grim wlrctl wlr-randr" >&2; exit 1; }

rm -rf os/shell/build/stage
DESTDIR="$PWD/os/shell/build/stage" cmake --install os/shell/build
test -x os/shell/build/stage/usr/bin/jarvis-shell
test -f os/shell/build/stage/usr/share/jarvis-shell/labwc/rc.xml
test -f os/shell/build/stage/usr/share/jarvis-shell/labwc/autostart
test -x os/shell/build/stage/usr/share/jarvis-shell/jarvis-shell-loop
# Jarvis.UI ships in its own package (jarvis-ui), never inside jarvis-shell.
test -z "$(find os/shell/build/stage -path '*Jarvis/UI*' -print -quit)"
test -f os/shell/build/stage/usr/share/jarvis/i18n/jarvis-shell_ar.qm
test -f os/shell/build/stage/usr/share/jarvis/i18n/jarvis-shell_en.qm
echo "jarvis-shell: build, tests and install layout OK"
