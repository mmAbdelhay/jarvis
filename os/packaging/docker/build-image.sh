#!/usr/bin/env bash
# build-image.sh --debs DIR --tag TAG [--context-only DIR]
# The jarvis-agent image (M2.5 contracts §6) from this build's jarvisd,
# jarvis-diag and jarvis-cli .debs. Never the helper, never pushes.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
debs="" tag="" ctx_only=""
while [ $# -gt 0 ]; do
  case $1 in
    --debs) debs=$2; shift 2 ;;
    --tag) tag=$2; shift 2 ;;
    --context-only) ctx_only=$2; shift 2 ;;
    *) echo "build-image: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "build-image: $*" >&2; exit 1; }
[ -d "$debs" ] && [ -n "$tag" ] || die "usage: build-image.sh --debs DIR --tag TAG [--context-only DIR]"
version=""
files=()
for p in jarvisd jarvis-diag jarvis-cli; do
  mapfile -t found < <(compgen -G "$debs/${p}_*.deb" || true)
  [ "${#found[@]}" -eq 1 ] || die "need exactly one $p .deb in $debs (found ${#found[@]})"
  v=${found[0]##*/}; v=${v#"${p}"_}; v=${v%_*.deb}
  if [ -z "$version" ]; then version=$v; elif [ "$v" != "$version" ]; then die "$p is $v, jarvisd is $version"; fi
  files+=("${found[0]}")
done
ctx=${ctx_only:-$(mktemp -d)}
rm -rf "$ctx"; mkdir -p "$ctx/debs"
cp "$here/Dockerfile" "$here/entrypoint.sh" "$ctx/"
cp "${files[@]}" "$ctx/debs/"
if [ -n "$ctx_only" ]; then echo "$ctx"; exit 0; fi
trap 'rm -rf "$ctx"' EXIT
docker build --platform linux/amd64 --pull --build-arg "VERSION=$version" -t "$tag" "$ctx"
echo "$tag"
