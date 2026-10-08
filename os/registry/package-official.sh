#!/usr/bin/env bash
# package-official.sh --out DIR — an artifact for every official server in
# os/registry/servers, from Plan J's build output $REGISTRY_BIN_DIR/<id>/
# (default os/go/dist-registry, produced by `make -C os/go dist`).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${REGISTRY_BIN_DIR:-$here/../go/dist-registry}
servers=${REGISTRY_SERVERS_DIR:-$here/servers}
out=""
while [ $# -gt 0 ]; do
  case $1 in
    --out) out=$2; shift 2 ;;
    *) echo "package-official: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || { echo "package-official: --out is required" >&2; exit 2; }
list=$(python3 - "$servers" <<'PY'
import json, pathlib, sys
for f in sorted(pathlib.Path(sys.argv[1]).glob("*.json")):
    e = json.loads(f.read_text())
    if e.get("tier") == "official":
        print(e["id"], e["version"], e["artifact"]["runtime"])
PY
)
[ -n "$list" ] || { echo "package-official: no official servers in $servers" >&2; exit 1; }
while read -r id version runtime; do
  if [ ! -d "$bin/$id" ]; then
    echo "package-official: missing $bin/$id (Plan J builds the official servers: make -C os/go dist)" >&2
    exit 1
  fi
  "$here/package-server.sh" --id "$id" --version "$version" --runtime "$runtime" --from "$bin/$id" --out "$out"
done <<<"$list"
