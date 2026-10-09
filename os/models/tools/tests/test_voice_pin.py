"""voice_pin.py: sha256 from the source (HF LFS oid or a streamed download), MODEL_CARD licenses."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import voice_pin  # noqa: E402

OID = "c" * 64


def fake_get_json(url: str):
    if url == "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main":
        return [{"type": "file", "path": "ggml-base.bin", "lfs": {"oid": OID, "size": 1}},
                {"type": "file", "path": "README.md"}]
    if url == "https://huggingface.co/api/models/rhasspy/piper-voices/tree/main/en/en_US/amy/medium":
        return [{"type": "file", "path": "en/en_US/amy/medium/en_US-amy-medium.onnx", "lfs": {"oid": "d" * 64}}]
    raise AssertionError(f"unexpected {url}")


def fake_stream(url: str) -> str:
    return "e" * 64


class PinTest(unittest.TestCase):
    def test_hf_lfs_oid_used(self):
        got = voice_pin.resolve_sha("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
                                    fake_get_json, fake_stream)
        self.assertEqual(got, OID)

    def test_hf_nested_path(self):
        src = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx"
        self.assertEqual(voice_pin.resolve_sha(src, fake_get_json, fake_stream), "d" * 64)

    def test_hf_missing_file_is_an_error(self):
        with self.assertRaises(LookupError):
            voice_pin.resolve_sha("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-nope.bin",
                                  fake_get_json, fake_stream)

    def test_hf_non_lfs_file_is_streamed(self):
        got = voice_pin.resolve_sha("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/README.md",
                                    fake_get_json, fake_stream)
        self.assertEqual(got, "e" * 64)

    def test_other_hosts_are_streamed(self):
        got = voice_pin.resolve_sha("https://github.com/x/y/releases/download/v1/m.onnx", fake_get_json, fake_stream)
        self.assertEqual(got, "e" * 64)

    def test_card_url(self):
        src = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx"
        self.assertEqual(voice_pin.card_url(src),
                         "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/MODEL_CARD")
        self.assertIsNone(voice_pin.card_url("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"))

    def test_card_licenses(self):
        card = "# Model card\n\n## Dataset\n\n* URL: https://x\n* License: CC BY 4.0\n\n## Training\n* license: MIT\n"
        self.assertEqual(voice_pin.card_licenses(card), ["CC BY 4.0", "MIT"])

    def test_pin_fills_only_missing_unless_all(self):
        reg = {"version": 1, "models": [
            {"id": "a", "source": "https://github.com/x/a.onnx", "sha256": None},
            {"id": "b", "source": "https://github.com/x/b.onnx", "sha256": "f" * 64}]}
        self.assertEqual(voice_pin.pin(reg, False, fake_get_json, fake_stream), ["a"])
        self.assertEqual(reg["models"][0]["sha256"], "e" * 64)
        self.assertEqual(reg["models"][1]["sha256"], "f" * 64)
        self.assertEqual(voice_pin.pin(reg, True, fake_get_json, fake_stream), ["b"])
        self.assertEqual(reg["models"][1]["sha256"], "e" * 64)


if __name__ == "__main__":
    unittest.main()
