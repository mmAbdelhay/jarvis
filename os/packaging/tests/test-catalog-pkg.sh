#!/usr/bin/env bash
# jarvis-models-catalog (contracts §4, §7).
source "$(dirname "$0")/lib.sh"
REPO_ROOT=$(cd "$PACKAGING_DIR/../.." && pwd)
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-models-catalog >/dev/null
deb=$tmp/out/jarvis-models-catalog_${OS_VERSION}_all.deb
check "catalog at contract path" deb_has "$deb" usr/share/jarvis/models/catalog.json
check "catalog 0644" test "$(deb_mode "$deb" usr/share/jarvis/models/catalog.json)" = "-rw-r--r--"
check "catalog identical to source" cmp -s <(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/jarvis/models/catalog.json) "$REPO_ROOT/os/models/catalog.json"
check "arch all" test "$(deb_field "$deb" Architecture)" = all
printf '{"version":1,"models":[]}' > "$tmp/bad.json"
check "an invalid catalog fails the build" bash -c "! MODELS_CATALOG='$tmp/bad.json' '$PACKAGING_DIR/build.sh' --out '$tmp/o2' jarvis-models-catalog >/dev/null 2>&1"
finish
