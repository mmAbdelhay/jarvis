# Sourced by os/iso/tests/test-*.sh.
set -euo pipefail
ISO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_ROOT=$(cd "$ISO_DIR/../.." && pwd)
failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
mktmp() { mktemp -d "${TMPDIR:-/tmp}/jiso.XXXXXX"; }
finish() {
  if [ "$failures" -gt 0 ]; then echo "$failures failure(s)" >&2; exit 1; fi
  echo "all passed"
}
