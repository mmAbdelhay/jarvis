#!/usr/bin/env bash
# Inside debian:trixie, as root: install the voice packages and run the round trip.
set -euo pipefail
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 sox \
  /debs/jarvis-voice-engines_*.deb /debs/jarvis-voice-models_*.deb >/dev/null
python3 /src/os/packaging/voice/check_roundtrip.py /usr/share/jarvis/voice/manifest.json
