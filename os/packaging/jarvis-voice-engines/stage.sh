#!/usr/bin/env bash
# Stage jarvis-voice-engines (M3 design §3.2): whisper.cpp's whisper-cli built
# from the pinned source with runtime-selected CPU backends (one build for
# AVX2 and older CPUs), and the pinned Piper release. Layout:
#   /usr/lib/jarvis/voice/bin/whisper-cli -> ../whisper/whisper-cli  (+ libwhisper, libggml*, RPATH $ORIGIN)
#   /usr/lib/jarvis/voice/bin/piper -> ../piper/piper          (+ its libraries and espeak-ng-data/)
# VOICE_ENGINES_PREBUILT=DIR (with whisper/ and piper/) skips fetch and build.
set -euo pipefail
stage=$1
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=engines.env
. "${VOICE_ENGINES_ENV:-$here/engines.env}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if [ -n "${VOICE_ENGINES_PREBUILT:-}" ]; then
  whisper_dir=$VOICE_ENGINES_PREBUILT/whisper
  piper_dir=$VOICE_ENGINES_PREBUILT/piper
else
  src=$(PINNED_FILE=${WHISPER_TARBALL:-} "$here/../lib/fetch-pinned.sh" \
    "$WHISPER_URL" "$WHISPER_SHA256" "whisper.cpp-$WHISPER_VERSION.tar.gz")
  mkdir -p "$tmp/whisper-src"
  tar -xzf "$src" -C "$tmp/whisper-src" --strip-components=1
  # shellcheck disable=SC2016 # $ORIGIN is for the dynamic linker, not the shell
  cmake -S "$tmp/whisper-src" -B "$tmp/whisper-build" -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF \
    -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH='$ORIGIN' >/dev/null
  cmake --build "$tmp/whisper-build" -j "$(nproc)" >/dev/null
  whisper_dir=$tmp/whisper
  mkdir -p "$whisper_dir"
  install -m0755 "$tmp/whisper-build/bin/whisper-cli" "$whisper_dir/whisper-cli"
  find "$tmp/whisper-build" -name '*.so*' \( -type f -o -type l \) -exec cp -a {} "$whisper_dir/" \;
  pf=$(PINNED_FILE=${PIPER_TARBALL:-} "$here/../lib/fetch-pinned.sh" \
    "$PIPER_URL" "$PIPER_SHA256" "piper-$PIPER_VERSION-linux_x86_64.tar.gz")
  tar -xzf "$pf" -C "$tmp"
  piper_dir=$tmp/piper
fi
for need in "$whisper_dir/whisper-cli" "$piper_dir/piper"; do
  [ -x "$need" ] || { echo "jarvis-voice-engines: missing $need" >&2; exit 1; }
done
[ -d "$piper_dir/espeak-ng-data" ] || { echo "jarvis-voice-engines: Piper has no espeak-ng-data/" >&2; exit 1; }
dest=$stage/usr/lib/jarvis/voice
mkdir -p "$dest/bin"
cp -a "$whisper_dir" "$dest/whisper"
cp -a "$piper_dir" "$dest/piper"
chmod 0755 "$dest/whisper/whisper-cli" "$dest/piper/piper"
ln -s ../whisper/whisper-cli "$dest/bin/whisper-cli"
ln -s ../piper/piper "$dest/bin/piper"
printf '%s\n' usr/lib/jarvis/voice/whisper usr/lib/jarvis/voice/piper > "$stage/.shlibs-libdirs"
doc=$stage/usr/share/doc/jarvis-voice-engines
mkdir -p "$doc"
cat > "$doc/UPSTREAM" <<EOF
whisper.cpp $WHISPER_VERSION (MIT), built from $WHISPER_URL (sha256 $WHISPER_SHA256).
Piper $PIPER_VERSION (MIT), binary release $PIPER_URL (sha256 $PIPER_SHA256).
Piper bundles onnxruntime (MIT) and espeak-ng (GPL-3.0-or-later); espeak-ng source:
https://github.com/rhasspy/espeak-ng (the fork Piper builds) and https://github.com/espeak-ng/espeak-ng.
EOF
