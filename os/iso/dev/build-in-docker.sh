#!/usr/bin/env bash
# build-in-docker.sh OUT_DIR [DEBS_DIR] — build the ISO in a privileged
# debian:trixie container, the same way CI does. Without DEBS_DIR, stub
# packages are built first. On Apple Silicon this runs under amd64
# emulation and takes a long time (see os/iso/README.md).
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
debs=${2:-}
if [ -z "$debs" ]; then
  debs=$out/debs
  mkdir -p "$debs"
  TRIXIE_DOCKER_ARGS="-v $debs:/out-debs" "$repo/os/packaging/dev/trixie.sh" "os/iso/dev/stub-debs.sh /out-debs"
fi
debs=$(cd "$debs" && pwd)
mkdir -p "$out/lb-cache"
exec docker run --rm --privileged --platform linux/amd64 \
  -v "$repo:/src:ro" -v "$debs:/debs:ro" -v "$out:/out" \
  debian:trixie /src/os/iso/build.sh --debs /debs --out /out/dist --work /tmp/iso-work --cache /out/lb-cache
