#!/usr/bin/env bash
# The voice round trip (Task 11) runs in Linux CI; this checks it statically.
source "$(dirname "$0")/lib.sh"
v=$PACKAGING_DIR/voice
check "roundtrip.sh parses" bash -n "$v/roundtrip.sh"
check "in-container.sh parses" bash -n "$v/in-container.sh"
check "check_roundtrip.py compiles" python3 -m py_compile "$v/check_roundtrip.py"
check "same whisper-cli arguments as stt.ts" grep -qF '"-l", "auto", "-nt", "-f"' "$v/check_roundtrip.py"
check "reads the package manifest" grep -qF '/usr/share/jarvis/voice/manifest.json' "$v/in-container.sh"
check "engines at the contract path" grep -qF '/usr/lib/jarvis/voice/bin/whisper-cli' "$v/check_roundtrip.py"
check "unprivileged container" bash -c "! grep -q -- '--privileged' '$v/roundtrip.sh'"
finish
