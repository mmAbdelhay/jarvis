#!/usr/bin/env bash
# Linux CI entry for jarvis-classic (Rafiq M4 contracts §2); Plan T calls it.
# Requires: repo root as cwd; the packages in os/classic/deps/debian-build.txt.
set -euo pipefail

cmake -S os/classic -B os/classic/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/classic/build
QT_QPA_PLATFORM=offscreen ctest --test-dir os/classic/build --output-on-failure
echo "jarvis-classic: build and tests OK"
