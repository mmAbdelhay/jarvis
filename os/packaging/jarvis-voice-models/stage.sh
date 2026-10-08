#!/usr/bin/env bash
# Stage jarvis-voice-models (M3 contracts §4) from the M2.5 voice registry.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
args=("$1" --list "${VOICE_MODELS_LIST:-$here/models.list}")
[ -z "${VOICE_REGISTRY:-}" ] || args+=(--registry "$VOICE_REGISTRY")
[ -z "${VOICE_CONFIGS:-}" ] || args+=(--configs "$VOICE_CONFIGS")
exec python3 "$here/../lib/voice_stage.py" "${args[@]}"
