#!/usr/bin/env bash
# Linux CI entry for jarvis-idle; Plan P calls it from the os workflow.
# Requires: repo root as cwd; the packages in os/idle/deps/debian-build.txt.
set -euo pipefail

cmake -S os/idle -B os/idle/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/usr
cmake --build os/idle/build
ctest --test-dir os/idle/build --output-on-failure
echo "jarvis-idle: build and tests OK"
