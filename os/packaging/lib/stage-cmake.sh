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
  drop_shared_translations "$stage"
  for path in "$@"; do
    if [ ! -e "$stage/$path" ]; then
      echo "stage: cmake --install did not produce /$path (contracts §7)" >&2
      exit 1
    fi
  done
  cp "$runtime" "$stage/.extra-depends"
}

# drop_shared_translations STAGE — compiled translations ship in jarvis-i18n
# (M4 Plan T), built from the same .ts files; a copy in another package would
# make two packages own one file and break the ISO build.
drop_shared_translations() {
  local stage=$1
  if [ -d "$stage/usr/share/jarvis/i18n" ]; then
    echo "stage: dropping $(find "$stage/usr/share/jarvis/i18n" -type f | wc -l) file(s) under /usr/share/jarvis/i18n (jarvis-i18n ships them)" >&2
    rm -rf "$stage/usr/share/jarvis/i18n"
    rmdir "$stage/usr/share/jarvis" 2>/dev/null || true
  fi
}
