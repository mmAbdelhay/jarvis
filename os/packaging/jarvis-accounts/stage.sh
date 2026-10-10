#!/usr/bin/env bash
# Stage jarvis-accounts (Plan Y §2.2, §5.4, §5.7), pins validated first.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
src=${ACCOUNTS_PINS:-$REPO_ROOT/os/models/accounts.json}
python3 - "$src" "$REPO_ROOT/os/models/tests" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[2])
from test_accounts import validate_accounts
problems = validate_accounts(json.load(open(sys.argv[1])))
for p in problems:
    print(f"jarvis-accounts: {p}", file=sys.stderr)
sys.exit(1 if problems else 0)
PY
install -D -m0644 "$src" "$1/usr/share/jarvis/accounts/accounts.json"
install -D -m0755 "$here/xdg-open" "$1/usr/lib/jarvis/accounts/bin/xdg-open"
for alias in sensible-browser x-www-browser www-browser; do
  ln -s xdg-open "$1/usr/lib/jarvis/accounts/bin/$alias"
done
