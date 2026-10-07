#!/usr/bin/env bash
# Stage the model catalog (contracts §4), validated first.
set -euo pipefail
src=${MODELS_CATALOG:-$REPO_ROOT/os/models/catalog.json}
python3 - "$src" "$REPO_ROOT/os/models/tests" <<'PY'
import json, sys
sys.path.insert(0, sys.argv[2])
from test_catalog import validate
problems = validate(json.load(open(sys.argv[1])))
for p in problems:
    print(f"jarvis-models-catalog: {p}", file=sys.stderr)
sys.exit(1 if problems else 0)
PY
install -D -m0644 "$src" "$1/usr/share/jarvis/models/catalog.json"
