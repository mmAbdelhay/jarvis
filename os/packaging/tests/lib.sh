# shellcheck shell=bash disable=SC2034
# Sourced by test-*.sh. Plain bash assertions, nothing to install.
set -euo pipefail
TESTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGING_DIR=$(cd "$TESTS_DIR/.." && pwd)
export OS_VERSION=${OS_VERSION:-9.9.9~test}
failures=0

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
# check NAME CMD... — runs CMD; stdin is passed through (use <<< for strings).
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
mktmp() { mktemp -d "${TMPDIR:-/tmp}/jpkg.XXXXXX"; }
deb_field() { dpkg-deb -f "$1" "$2"; }
deb_list() { dpkg-deb -c "$1"; }
deb_has() { deb_list "$1" | awk '{print $6}' | grep -qx "./${2#/}"; }
deb_mode() { deb_list "$1" | awk -v p="./${2#/}" '$6 == p {print $1}'; }
deb_owners() { deb_list "$1" | awk '{print $2}' | sort -u; }
deb_script() { dpkg-deb --ctrl-tarfile "$1" | tar -xO "./$2"; }
deb_script_mode() { dpkg-deb --ctrl-tarfile "$1" | tar -tv | awk -v p="./$2" '$6 == p {print $1}'; }
finish() {
  if [ "$failures" -gt 0 ]; then echo "$failures failure(s)" >&2; exit 1; fi
  echo "all passed"
}
