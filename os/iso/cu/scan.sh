# Sourced by session.sh (and tests). Safe under `set -o pipefail`.
# png_hits PATH... — prints every regular file under the existing PATHs (files
# or directories) that contains a base64 or raw PNG signature. Missing paths
# are skipped; find/xargs/grep exit codes never decide the result (a missing
# directory used to make find exit 1 and turn the whole scan into a pass).
png_hits() {
  local existing=() p
  for p in "$@"; do [ -e "$p" ] && existing+=("$p"); done
  [ "${#existing[@]}" -gt 0 ] || return 0
  find "${existing[@]}" -type f -print0 2>/dev/null |
    LC_ALL=C xargs -0 -r grep -l -a -e 'iVBORw0KGgo' -e $'\x89PNG' -- 2>/dev/null || true
}
# png_files DIR... — prints *.png files under the existing DIRs.
png_files() {
  local existing=() p
  for p in "$@"; do [ -d "$p" ] && existing+=("$p"); done
  [ "${#existing[@]}" -gt 0 ] || return 0
  find "${existing[@]}" -name '*.png' 2>/dev/null || true
}
