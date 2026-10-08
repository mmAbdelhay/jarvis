#!/usr/bin/env bash
# Stage jarvis-recipes (M4 contracts §4): the reviewed recipes, validated
# first (tool allowlist, both languages), to /usr/share/jarvis/recipes/.
set -euo pipefail
stage=$1
src=${RECIPES_DIR:-$REPO_ROOT/os/recipes}
python3 "$REPO_ROOT/os/recipes/tools/recipes.py" validate "$src"
for f in "$src"/*.json; do
  install -D -m0644 "$f" "$stage/usr/share/jarvis/recipes/$(basename "$f")"
done
