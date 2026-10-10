#!/usr/bin/env bash
# The Debian version shared by every Jarvis OS .deb and the ISO built with
# them. Packages depend on each other with (= version), so it must be the same
# for every package built from one commit: CI sets OS_VERSION once per run;
# locally it is derived from the commit, never from the clock.
set -euo pipefail
if [ -n "${OS_VERSION:-}" ]; then
  printf '%s\n' "${OS_VERSION#os-v}"
  exit 0
fi
here=$(cd "$(dirname "$0")" && pwd)
if stamp=$(git -C "$here" log -1 --format=%cd --date=format:%Y%m%d%H%M 2>/dev/null) &&
  sha=$(git -C "$here" rev-parse --short=10 HEAD 2>/dev/null); then
  printf '0.5.0~v11.%s.g%s\n' "$stamp" "$sha"
else
  printf '0.5.0~v11.dev\n'
fi
