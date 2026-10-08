#!/usr/bin/env python3
"""Piper -> Whisper round trip over the installed voice packages (M3 design §3.2).

For every tts voice in the manifest: speak a fixed phrase with Piper, resample
to 16 kHz mono (the format of voice:utterance), and transcribe it with every
stt model using the same arguments as stt.ts. The detected language must be
the voice's; the English transcript must contain the key word.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Contracts §5 #13: engines live under /usr/lib/jarvis/voice/bin/.
WHISPER = "/usr/lib/jarvis/voice/bin/whisper-cli"
PIPER = "/usr/lib/jarvis/voice/bin/piper"
PHRASES = {"en": ("Make my screen brighter.", "brighter"), "ar": ("افتح مجلد الصور", None)}
LANG = re.compile(r"auto-detected language:\s*([a-z]{2,3})", re.I)


def main(manifest_path: str) -> int:
    m = json.loads(Path(manifest_path).read_text())
    failures = 0
    if not m["stt"] or not m["tts"]:
        print("FAIL manifest lists no stt or no tts model")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        for voice in m["tts"]:
            text, word = PHRASES[voice["lang"]]
            raw = Path(tmp) / f"{voice['id']}.wav"
            wav16 = Path(tmp) / f"{voice['id']}-16k.wav"
            subprocess.run([PIPER, "--model", voice["path"], "--config", voice["config"], "--output_file", str(raw)],
                           input=text.encode(), check=True, capture_output=True)
            subprocess.run(["sox", str(raw), "-r", "16000", "-c", "1", "-b", "16", str(wav16)], check=True)
            for stt in m["stt"]:
                r = subprocess.run([WHISPER, "-m", stt["path"], "-l", "auto", "-nt", "-f", str(wav16)],
                                   capture_output=True, text=True)
                said = " ".join(r.stdout.split()).lower()
                found = LANG.search(r.stderr)
                lang = found[1].lower() if found else ""
                ok = r.returncode == 0 and lang == voice["lang"] and (word is None or word in said)
                print(f"{'ok  ' if ok else 'FAIL'} {voice['id']} -> {stt['id']}: lang={lang} text={said!r}")
                if not ok:
                    failures += 1
                    print(r.stderr[-1500:])
    print("all passed" if failures == 0 else f"{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
