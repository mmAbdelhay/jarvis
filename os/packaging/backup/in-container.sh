#!/usr/bin/env bash
# Inside the offline container: start ollama the way ollama.service does,
# then ask the backup model questions that need a tool.
set -euo pipefail
if python3 -c 'import socket; socket.create_connection(("1.1.1.1", 443), 3)' 2>/dev/null; then
  echo "FAIL the container still has a network; the test would prove nothing" >&2
  exit 1
fi
store=/var/lib/ollama/models
runuser -u ollama -- env HOME=/var/lib/ollama OLLAMA_MODELS="$store" OLLAMA_HOST=127.0.0.1:11434 \
  /usr/bin/ollama serve > /tmp/ollama.log 2>&1 &
for _ in $(seq 60); do
  python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=2)' 2>/dev/null && break
  sleep 1
done
tag=$(python3 -c 'import json; print(next(m["ollamaTag"] for m in json.load(open("/src/os/models/catalog.json"))["models"] if m["role"] == "backup"))')
if ! python3 /src/os/packaging/backup/check_chat.py --tag "$tag"; then
  echo "--- ollama.log (tail) ---"; tail -n 40 /tmp/ollama.log
  exit 1
fi
