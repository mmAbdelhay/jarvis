# shellcheck shell=bash
# Sourced by stage.sh scripts.
#
# take SRC_ROOT STAGE MODE PATH
#   Copies SRC_ROOT/PATH to STAGE/PATH with MODE. PATH is the install path
#   without the leading slash, so the upstream DESTDIR-style tree and the
#   package tree line up. A missing file is a build error that names the
#   contract and the upstream build command ($TAKE_HINT), never an empty .deb.
take() {
  local src_root=$1 stage=$2 mode=$3 path=$4
  if [ ! -f "$src_root/$path" ]; then
    echo "stage: missing $src_root/$path" >&2
    echo "  produced by: ${TAKE_HINT:-the upstream build}" >&2
    echo "  see docs/superpowers/specs/2026-10-07-jarvis-os-m1-contracts.md" >&2
    exit 1
  fi
  install -D -m "$mode" "$src_root/$path" "$stage/$path"
}
