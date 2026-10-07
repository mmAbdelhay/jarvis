#!/usr/bin/env bash
# Build Jarvis OS .debs from staged trees (contracts §4).
#
#   os/packaging/build.sh --out DIR PACKAGE...
#
# PACKAGE is a directory under $JARVIS_PACKAGING_DEFS (default: this one)
# holding control.in, an executable stage.sh and optional maintainer scripts
# (preinst, postinst, prerm, postrm). stage.sh is called as
# `stage.sh STAGE_DIR` with REPO_ROOT exported and must fill STAGE_DIR with
# the files exactly as they install.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
defs=${JARVIS_PACKAGING_DEFS:-$here}
REPO_ROOT=${REPO_ROOT:-$(cd "$here/../.." && pwd)}
export REPO_ROOT

out=""
pkgs=()
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    -*) echo "build.sh: unknown option $1" >&2; exit 2 ;;
    *) pkgs+=("$1"); shift ;;
  esac
done
if [ -z "$out" ] || [ ${#pkgs[@]} -eq 0 ]; then
  echo "usage: build.sh --out DIR PACKAGE..." >&2
  exit 2
fi

version=$("$here/version.sh")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

for pkg in "${pkgs[@]}"; do
  def=$defs/$pkg
  if [ ! -f "$def/control.in" ] || [ ! -x "$def/stage.sh" ]; then
    echo "build.sh: $def needs control.in and an executable stage.sh" >&2
    exit 2
  fi
  echo "== $pkg $version" >&2
  mkdir -p "$work/$pkg"
  "$def/stage.sh" "$work/$pkg"
  "$here/lib/build-deb.sh" --control "$def/control.in" --root "$work/$pkg" \
    --scripts "$def" --version "$version" --out "$out"
done
