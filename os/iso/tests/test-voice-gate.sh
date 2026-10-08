#!/usr/bin/env bash
# The ISO build's voice-model license gate (M2.5 design §3.6, contracts §4)
# and jarvis-cli on the ISO.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
voice=$REPO_ROOT/os/models/tools/voice.py
build=$ISO_DIR/build.sh

check "build.sh runs the voice gate on the chroot" grep -qF 'models/tools/voice.py" scan "$work/chroot"' "$build"
check "the gate runs after verify-chroot" python3 - "$build" <<'PY'
import sys
t = open(sys.argv[1]).read()
assert t.index('scripts/verify-chroot.sh" "$work/chroot"') < t.index('voice.py" scan'), "order"
PY
check "build.sh makes sure python3 exists" grep -qF 'command -v python3 >/dev/null ||' "$build"
check "jarvis-cli is a required .deb" grep -qF 'jarvis-branding jarvis-cli"' "$build"
check "jarvis-cli is in the ISO package list" grep -qx jarvis-cli "$ISO_DIR/config/package-lists/jarvis.list.chroot"

# A chroot with only registered, redistributable models passes; the
# non-redistributable wake model, renamed and moved, fails and is named.
c=$tmp/chroot; mkdir -p "$c/usr/share/jarvis/voice/whisper" "$c/opt/x"
printf 'fake-stt-model' > "$c/usr/share/jarvis/voice/whisper/ggml-base.bin"
stt=$(sha256sum "$c/usr/share/jarvis/voice/whisper/ggml-base.bin" | cut -d' ' -f1)
wake=$(printf 'fake-wake' | sha256sum | cut -d' ' -f1)
cat > "$tmp/voice.json" <<EOF
{"version": 1, "models": [
 {"id": "whisper-base", "kind": "stt", "file": "whisper/ggml-base.bin", "sha256": "$stt", "license": "MIT",
  "redistributable": true, "source": "https://example.invalid/ggml-base.bin", "notes": ""},
 {"id": "oww-hey-jarvis", "kind": "wake", "file": "wake/hey_jarvis_v0.1.onnx", "sha256": "$wake",
  "license": "CC-BY-NC-SA-4.0", "redistributable": false, "source": "https://example.invalid/hey.onnx", "notes": ""}]}
EOF
check "clean chroot passes" python3 "$voice" scan "$c" --registry "$tmp/voice.json"
printf 'fake-wake' > "$c/opt/x/renamed.onnx"
out=$(python3 "$voice" scan "$c" --registry "$tmp/voice.json" 2>&1) && code=0 || code=$?
check "non-redistributable model fails the gate" test "$code" -eq 1
check "the failure names the file and the license" grep -q 'opt/x/renamed.onnx.*CC-BY-NC-SA-4.0' <<<"$out"
check "the committed registry is valid" python3 "$voice" validate

if command -v dpkg-deb >/dev/null; then
  "$ISO_DIR/dev/stub-debs.sh" "$tmp/stubs" >/dev/null
  check "stub jarvis-cli built" test -f "$tmp/stubs/jarvis-cli_0.0.0~stub1_all.deb"
  check "stub jarvis-cli has the real launcher" grep -q '/usr/lib/jarvis/cli/jarvis.mjs' \
    <<<"$(dpkg-deb --fsys-tarfile "$tmp/stubs/jarvis-cli_0.0.0~stub1_all.deb" | tar -xO ./usr/bin/jarvis)"
else
  echo "SKIP stub jarvis-cli (needs dpkg-deb: run via os/packaging/dev/trixie.sh)"
fi
finish
