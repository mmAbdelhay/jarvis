#!/usr/bin/env bash
# Stage jarvis-backup-model (M4 contracts §1): the catalog's role=backup model,
# byte for byte as pinned in os/models/backup-model.lock.json, laid out as an
# Ollama store under /var/lib/ollama/models.
#   BACKUP_MODEL_MIRROR     a directory laid out like OLLAMA_MODELS (tests, offline builds)
#   BACKUP_MODEL_CACHE_DIR  download cache (default ~/.cache/jarvis-build/backup-model; CI caches it)
#   BACKUP_MODEL_CATALOG, BACKUP_MODEL_LOCK   other inputs (tests)
set -euo pipefail
stage=$1
lock=${BACKUP_MODEL_LOCK:-$REPO_ROOT/os/models/backup-model.lock.json}
inputs=(--catalog "${BACKUP_MODEL_CATALOG:-$REPO_ROOT/os/models/catalog.json}" --lock "$lock")
cache=${BACKUP_MODEL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/jarvis-build/backup-model}
mirror=()
if [ -n "${BACKUP_MODEL_MIRROR:-}" ]; then mirror=(--mirror "$BACKUP_MODEL_MIRROR"); fi
python3 "$REPO_ROOT/os/models/tools/backup_model.py" "${inputs[@]}" stage "$stage" --cache "$cache" "${mirror[@]}"
install -d "$stage/usr/share/doc/jarvis-backup-model"
python3 - "$lock" > "$stage/usr/share/doc/jarvis-backup-model/MODEL" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))
print(f"Ollama model {lock['ollamaTag']}, manifest sha256 {lock['manifest']['sha256']}")
for b in lock["blobs"]:
    print(f"{b['digest']}  {b['size']}  {b['mediaType']}")
print("Licence: the application/vnd.ollama.image.license blob above,")
print("in /var/lib/ollama/models/blobs.")
PY
echo none > "$stage/.deb-compression"
