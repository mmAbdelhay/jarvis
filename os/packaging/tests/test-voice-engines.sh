#!/usr/bin/env bash
# jarvis-voice-engines from a prebuilt tree, the committed pins, fetch-pinned.sh.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
pre=$tmp/pre
mkdir -p "$pre/whisper" "$pre/piper/espeak-ng-data"
cp /usr/bin/true "$pre/whisper/whisper-cli"; cp /usr/bin/true "$pre/piper/piper"
echo data > "$pre/piper/espeak-ng-data/phontab"
if [ "${1:-}" = --portable ]; then
  mkdir -p "$tmp/stage"
  VOICE_ENGINES_PREBUILT=$pre "$PACKAGING_DIR/jarvis-voice-engines/stage.sh" "$tmp/stage"
  check "whisper entry point resolves" test -x "$tmp/stage/usr/lib/jarvis/voice/bin/whisper-cli"
  check "piper entry point resolves" test -x "$tmp/stage/usr/lib/jarvis/voice/bin/piper"
  check "whisper entry point runs" "$tmp/stage/usr/lib/jarvis/voice/bin/whisper-cli"
  check "piper entry point runs" "$tmp/stage/usr/lib/jarvis/voice/bin/piper"
  check "Piper data preserved" test -f "$tmp/stage/usr/lib/jarvis/voice/piper/espeak-ng-data/phontab"
else
VOICE_ENGINES_PREBUILT=$pre "$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-voice-engines >/dev/null
deb=$tmp/out/jarvis-voice-engines_${OS_VERSION}_amd64.deb
check "whisper-cli at its path" deb_has "$deb" usr/lib/jarvis/voice/bin/whisper-cli
check "whisper-cli 0755" test "$(deb_mode "$deb" usr/lib/jarvis/voice/whisper/whisper-cli)" = "-rwxr-xr-x"
check "piper at its path" deb_has "$deb" usr/lib/jarvis/voice/bin/piper
check "espeak-ng data beside piper" deb_has "$deb" usr/lib/jarvis/voice/piper/espeak-ng-data/phontab
upstream=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/doc/jarvis-voice-engines/UPSTREAM)
check "UPSTREAM names espeak-ng's GPL and its source" grep -q 'GPL-3.0-or-later.*' <<<"$upstream"
check "a player for piper.ts" grep -q 'pipewire-bin' <<<"$(deb_field "$deb" Depends)"
check "arch amd64" test "$(deb_field "$deb" Architecture)" = amd64

fi

env=$PACKAGING_DIR/jarvis-voice-engines/engines.env
check "whisper pin is a sha256" grep -Eq '^WHISPER_SHA256=[0-9a-f]{64}$' "$env"
check "piper pin is a sha256" grep -Eq '^PIPER_SHA256=[0-9a-f]{64}$' "$env"
check "whisper from a ggml-org tag" grep -Eq '^WHISPER_URL=https://github\.com/ggml-org/whisper\.cpp/archive/refs/tags/v[0-9.]+\.tar\.gz$' "$env"
check "piper from a rhasspy release" grep -Eq '^PIPER_URL=https://github\.com/rhasspy/piper/releases/download/' "$env"

rm -rf "$pre/piper/espeak-ng-data"
err=$(VOICE_ENGINES_PREBUILT=$pre "$PACKAGING_DIR/jarvis-voice-engines/stage.sh" "$tmp/stage" 2>&1 || true)
check "Piper without espeak-ng-data is refused" grep -q 'espeak-ng-data' <<<"$err"

fp=$PACKAGING_DIR/lib/fetch-pinned.sh
f=$tmp/blob; echo hello > "$f"; good=$(sha256sum "$f" | cut -d' ' -f1)
bad=$(printf 'a%.0s' $(seq 64))
check "a pinned file is accepted" test "$(PINNED_FILE=$f "$fp" https://example.invalid/x "$good" x)" = "$f"
check "a wrong sha256 is refused" bash -c "! PINNED_FILE='$f' '$fp' https://example.invalid/x $bad x 2>/dev/null"
check "an empty pin is refused" bash -c "! PINNED_FILE='$f' '$fp' https://example.invalid/x '' x 2>/dev/null"
mkdir -p "$tmp/cache"; echo tampered > "$tmp/cache/y"
JARVIS_BUILD_CACHE=$tmp/cache "$fp" https://example.invalid/y "$good" y >/dev/null 2>&1 || true
check "a cached file with the wrong sha256 is deleted" test ! -e "$tmp/cache/y"
finish
