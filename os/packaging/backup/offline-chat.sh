#!/usr/bin/env bash
# os/packaging/backup/offline-chat.sh --debs DIR — the packaged backup model
# answers with a tool call with no network at all (M4 design §2.1, contracts
# §1). Installs jarvis-ollama + jarvis-backup-model in an unprivileged
# debian:trixie container, cuts the container's network, then asks.
# Linux CI only: a 1.7B model on the Mac's emulated amd64 is far too slow.
set -euo pipefail
debs=""
while [ $# -gt 0 ]; do
  case $1 in
    --debs) debs=$2; shift 2 ;;
    *) echo "offline-chat.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$debs" ] || { echo "usage: offline-chat.sh --debs DIR" >&2; exit 2; }
repo=$(cd "$(dirname "$0")/../../.." && pwd)
debs=$(cd "$debs" && pwd)
for p in jarvis-ollama jarvis-backup-model; do
  compgen -G "$debs/${p}_*.deb" >/dev/null || { echo "offline-chat.sh: no $p .deb in $debs" >&2; exit 1; }
done
name=jarvis-backup-offline-$$
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --platform linux/amd64 -v "$repo:/src:ro" -v "$debs:/debs:ro" \
  debian:trixie sleep infinity >/dev/null
docker exec -e DEBIAN_FRONTEND=noninteractive "$name" bash -euo pipefail -c '
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends python3 /debs/jarvis-ollama_*.deb /debs/jarvis-backup-model_*.deb >/dev/null'
docker network disconnect bridge "$name"
docker exec "$name" bash /src/os/packaging/backup/in-container.sh
