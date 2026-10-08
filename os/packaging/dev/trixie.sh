#!/usr/bin/env bash
# Run one command inside debian:trixie (amd64) with the repository at /src.
# The dpkg tools are Linux-only; this is how the macOS dev machine runs
# packaging and ISO tests.
#
#   os/packaging/dev/trixie.sh 'os/packaging/tests/run.sh'
#   TRIXIE_PACKAGES="cmake gcc libc6-dev" os/packaging/dev/trixie.sh '...'   extra apt packages
#   TRIXIE_DOCKER_ARGS="--privileged" os/packaging/dev/trixie.sh '...'
set -euo pipefail
if [ $# -ne 1 ]; then
  echo "usage: $0 'COMMAND'" >&2
  exit 2
fi
repo=$(cd "$(dirname "$0")/../../.." && pwd)
# shellcheck disable=SC2086 # TRIXIE_DOCKER_ARGS is a list of flags on purpose
exec docker run --rm --platform linux/amd64 ${TRIXIE_DOCKER_ARGS:-} \
  -e DEBIAN_FRONTEND=noninteractive -e OS_VERSION \
  -v "$repo:/src" -w /src debian:trixie bash -euo pipefail -c "
    sed -i 's/^Components: main\$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources  # fonts-ibm-plex
    apt-get update -qq >/dev/null
    apt-get install -y -qq --no-install-recommends \
      dpkg-dev xz-utils curl ca-certificates git python3 file shellcheck ${TRIXIE_PACKAGES:-} >/dev/null
    (cd / && git config --global --add safe.directory /src)
    $1"
