#!/usr/bin/env bash
# jarvis-voice-models (M3 contracts §4) from a fake registry and mirror.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
python3 - "$tmp" <<'PY'
import hashlib, json, sys
from pathlib import Path
t = Path(sys.argv[1]); (t / "mirror").mkdir(); (t / "configs").mkdir()
data = {"ggml-base.bin": b"b", "ggml-small.bin": b"s", "en_US-amy-medium.onnx": b"a"}
for n, d in data.items():
    (t / "mirror" / n).write_bytes(d)
(t / "configs" / "en_US-amy-medium.onnx.json").write_text('{"audio": {"sample_rate": 22050}}')
def e(i, k, f, lic="MIT"):
    return {"id": i, "kind": k, "file": f, "sha256": hashlib.sha256(data[f.split("/")[1]]).hexdigest(),
            "license": lic, "redistributable": True, "source": "https://example.invalid/" + f.split("/")[1], "notes": ""}
reg = {"version": 2, "models": [e("whisper-base", "stt", "stt/ggml-base.bin"), e("whisper-small", "stt", "stt/ggml-small.bin"),
       e("piper-en_US-amy-medium", "tts", "tts/en_US-amy-medium.onnx", "CC-BY-4.0")]}
(t / "voice.json").write_text(json.dumps(reg))
PY
printf 'whisper-base\nwhisper-small\npiper-en_US-amy-medium\npiper-ar_JO-kareem-medium ?\n' > "$tmp/models.list"
VOICE_REGISTRY=$tmp/voice.json VOICE_CONFIGS=$tmp/configs VOICE_MIRROR=$tmp/mirror VOICE_MODELS_LIST=$tmp/models.list \
  "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-voice-models >/dev/null 2>"$tmp/err"
deb=$tmp/out/jarvis-voice-models_${OS_VERSION}_all.deb
for p in usr/share/jarvis/voice/stt/ggml-base.bin usr/share/jarvis/voice/stt/ggml-small.bin \
  usr/share/jarvis/voice/tts/en_US-amy-medium.onnx usr/share/jarvis/voice/tts/en_US-amy-medium.onnx.json \
  usr/share/jarvis/voice/manifest.json usr/share/doc/jarvis-voice-models/MODELS; do
  check "ships /$p" deb_has "$deb" "$p"
done
check "models are 0644" test "$(deb_mode "$deb" usr/share/jarvis/voice/stt/ggml-base.bin)" = "-rw-r--r--"
check "arch all" test "$(deb_field "$deb" Architecture)" = all
check "missing optional voice is a warning" grep -q 'warning: skipping optional piper-ar_JO-kareem-medium' "$tmp/err"
check "no wake-word directory" bash -c '! dpkg-deb -c "$1" | grep -q voice/wake' _ "$deb"
printf 'tampered' > "$tmp/mirror/ggml-small.bin"
err=$(VOICE_REGISTRY=$tmp/voice.json VOICE_CONFIGS=$tmp/configs VOICE_MIRROR=$tmp/mirror VOICE_MODELS_LIST=$tmp/models.list \
  "$PACKAGING_DIR/build.sh" --out "$tmp/out2" jarvis-voice-models 2>&1 || true)
check "tampered model fails the build" test ! -e "$tmp/out2/jarvis-voice-models_${OS_VERSION}_all.deb"
check "failure names the model" grep -q 'whisper-small: sha256' <<<"$err"
finish
