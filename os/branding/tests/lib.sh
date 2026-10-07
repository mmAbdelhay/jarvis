# shellcheck shell=bash disable=SC2034
# Sourced by os/branding/tests/test-*.sh.
set -euo pipefail
TESTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BRANDING_DIR=$(cd "$TESTS_DIR/.." && pwd)
REPO_ROOT=$(cd "$BRANDING_DIR/../.." && pwd)
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
mktmp() { mktemp -d "${TMPDIR:-/tmp}/jbrand.XXXXXX"; }
finish() {
  if [ "$failures" -gt 0 ]; then echo "$failures failure(s)" >&2; exit 1; fi
  echo "all passed"
}
