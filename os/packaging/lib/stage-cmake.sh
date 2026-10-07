# shellcheck shell=bash
# Sourced by the Qt packages' stage.sh (Plan E, contracts §7).
# stage_cmake STAGE BUILD_DIR RUNTIME_LIST HINT PATH...
#   DESTDIR-installs BUILD_DIR with E's own install() rules, checks every
#   contract PATH (relative, no leading slash) and takes E's runtime package
#   list as extra Depends, so they match by construction (M1 §6.18 pattern).
stage_cmake() {
  local stage=$1 build=$2 runtime=$3 hint=$4 path
  shift 4
  if [ ! -f "$build/CMakeCache.txt" ]; then
    echo "stage: no CMake build at $build" >&2
    echo "  $hint" >&2
    exit 1
  fi
  if [ ! -f "$runtime" ]; then
    echo "stage: no runtime package list at $runtime (Plan E)" >&2
    exit 1
  fi
  DESTDIR=$stage cmake --install "$build" --prefix /usr >/dev/null
  for path in "$@"; do
    if [ ! -e "$stage/$path" ]; then
      echo "stage: cmake --install did not produce /$path (contracts §7)" >&2
      exit 1
    fi
  done
  cp "$runtime" "$stage/.extra-depends"
}
