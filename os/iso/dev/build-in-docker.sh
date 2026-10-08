#!/usr/bin/env bash
# build-in-docker.sh OUT_DIR [DEBS_DIR] — build the ISO in a privileged
# debian:trixie container, the same way CI does. Without DEBS_DIR, the ten E/F/G/M1
# packages are stubbed and the four H packages built for real (throwaway key). On Apple Silicon this runs under amd64
# emulation and takes a long time (see os/iso/README.md).
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
debs=${2:-}
if [ -z "$debs" ]; then
  debs=$out/debs
  mkdir -p "$debs"
  TRIXIE_DOCKER_ARGS="-v $debs:/out-debs" \
  TRIXIE_PACKAGES="gpg gpg-agent zstd librsvg2-bin grub-common fonts-ibm-plex" \
    "$repo/os/packaging/dev/trixie.sh" '
      os/iso/dev/stub-debs.sh /out-debs &&
      mkdir -p /tmp/k && JARVIS_ARCHIVE_PUBKEY=/tmp/k/pubkey.asc &&
      os/repo/test-key.sh /tmp/k >/dev/null && export JARVIS_ARCHIVE_PUBKEY &&
      os/packaging/build.sh --out /out-debs jarvis-branding jarvis-models-catalog jarvis-archive-keyring jarvis-ollama'
fi
debs=$(cd "$debs" && pwd)
mkdir -p "$out/lb-cache"
exec docker run --rm --privileged --platform linux/amd64 \
  -v "$repo:/src:ro" -v "$debs:/debs:ro" -v "$out:/out" \
  debian:trixie /src/os/iso/build.sh --debs /debs --out /out/dist --work /tmp/iso-work --cache /out/lb-cache
