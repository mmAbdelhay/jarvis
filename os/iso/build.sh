#!/usr/bin/env bash
# Build the Jarvis OS live ISO (design §9). Runs as root in Debian trixie:
# in CI a privileged debian:trixie container, locally os/iso/dev/build-in-docker.sh.
#
#   build.sh --debs DIR --out DIR [--work DIR] [--cache DIR]
#
# The five Jarvis .debs go into config/packages.chroot/, which live-build
# turns into a trusted local apt repository inside the chroot, so they are
# installed with normal dependency resolution and the repo is removed after.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
debs="" out="" work=/tmp/jarvis-iso-work cache=""
while [ $# -gt 0 ]; do
  case $1 in
    --debs) debs=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --work) work=$2; shift 2 ;;
    --cache) cache=$2; shift 2 ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "build.sh: $*" >&2; exit 1; }
[ -n "$debs" ] && [ -n "$out" ] || die "usage: build.sh --debs DIR --out DIR [--work DIR] [--cache DIR]"
[ "$(id -u)" = 0 ] || die "must run as root (live-build needs it)"
# shellcheck source=/dev/null
. /etc/os-release
[ "${VERSION_CODENAME:-}" = trixie ] || die "run in Debian trixie (found ${VERSION_CODENAME:-unknown})"
for p in jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper; do
  compgen -G "$debs/${p}_*_amd64.deb" >/dev/null || die "no $p .deb in $debs"
done

if ! command -v lb >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    live-build xorriso squashfs-tools ca-certificates dpkg-dev >/dev/null
fi

mkdir -p "$out"
rm -rf "$work"
mkdir -p "$work"
cp -a "$here/auto" "$here/config" "$here/bootappend" "$work/"
cp "$here/../branding/brand.env" "$work/"
mkdir -p "$work/config/packages.chroot"
cp "$debs"/*.deb "$work/config/packages.chroot/"
"$here/scripts/bootloader-timeouts.sh" "$work"
if [ -n "$cache" ] && [ -d "$cache" ]; then
  mkdir -p "$work/cache"
  cp -a "$cache/." "$work/cache/"
fi

cd "$work"
lb config
lb build 2>&1 | tee "$out/build.log"

"$here/scripts/verify-chroot.sh" "$work/chroot" 2>&1 | tee -a "$out/build.log"
"$here/scripts/release-guard.sh" "$work/chroot" "$work/binary"

# Soft failures (e.g. Flathub appstream) for the CI job summary.
grep -o 'JARVIS-BUILD-WARNING: .*' "$out/build.log" | sort -u > "$out/warnings.txt" || true

version=$(dpkg-deb -f "$(compgen -G "$debs/jarvisd_*_amd64.deb" | head -n1)" Version)
# shellcheck source=../branding/lib/brand.sh
. "$here/../branding/lib/brand.sh"
brand_load
name="${DISTRO_ID}-${version}-amd64.iso"
mv "$work"/*.hybrid.iso "$out/$name"
cp "$work"/*.packages "$out/$name.packages"
(cd "$out" && sha256sum "$name" > "$name.sha256")

# Only downloaded .debs are worth keeping between builds; a cached bootstrap
# chroot would freeze the base system at whatever day it was made.
if [ -n "$cache" ]; then
  mkdir -p "$cache"
  for d in packages.bootstrap packages.chroot packages.binary; do
    if [ -d "$work/cache/$d" ]; then
      rm -rf "${cache:?}/$d"
      cp -a "$work/cache/$d" "$cache/"
    fi
  done
fi
echo "build.sh: $out/$name"
