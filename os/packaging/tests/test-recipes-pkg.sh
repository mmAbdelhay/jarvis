#!/usr/bin/env bash
# jarvis-recipes (M4 contracts §4): validated recipes in /usr/share/jarvis/recipes.
# shellcheck source=os/packaging/tests/lib.sh
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
REPO_ROOT=$(cd "$PACKAGING_DIR/../.." && pwd)
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-recipes >/dev/null
deb=$tmp/out/jarvis-recipes_${OS_VERSION}_all.deb
check "Architecture all" test "$(deb_field "$deb" Architecture)" = all
for r in python-dev node-dev docker go-dev media-basics office-basics jarvis-workspace; do
  f=usr/share/jarvis/recipes/$r.json
  check "$r shipped 0644" test "$(deb_mode "$deb" "$f")" = -rw-r--r--
  check "$r byte-identical to os/recipes" cmp -s "$REPO_ROOT/os/recipes/$r.json" <(dpkg-deb --fsys-tarfile "$deb" | tar -xO "./$f")
done
check "only recipes are shipped (no tools, tests or README)" \
  test -z "$(deb_list "$deb" | awk '{print $6}' | grep -v -e '/$' -e '\.json$' -e '^./usr/share/doc/')"
mkdir -p "$tmp/bad"
cp "$REPO_ROOT"/os/recipes/*.json "$tmp/bad/"
python3 - "$tmp/bad/docker.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
r["steps"].append({"tool": "users.add", "input": {"username": "x"}, "title": {"en": "Add", "ar": "إضافة"}})
json.dump(r, open(sys.argv[1], "w"), ensure_ascii=False)
PY
status=0
err=$(RECIPES_DIR=$tmp/bad "$PACKAGING_DIR/build.sh" --out "$tmp/o2" jarvis-recipes 2>&1) || status=$?
check "validator failure makes the build exit nonzero" test "$status" -ne 0
check "a recipe calling a forbidden tool fails the build" test ! -e "$tmp/o2/jarvis-recipes_${OS_VERSION}_all.deb"
check "the error names the tool" grep -q "'users.add' is not allowed" <<<"$err"
finish
