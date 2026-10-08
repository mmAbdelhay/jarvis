"""voice_stage.py: jarvis-voice-models from the voice registry (M3 contracts §4)."""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import voice_stage  # noqa: E402

BASE, SMALL, AMY, KAREEM, WAKE = b"base", b"small", b"amy", b"kareem", b"wake"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def entry(mid, kind, file, data, lic="MIT", redistributable=True):
    return {"id": mid, "kind": kind, "file": file, "sha256": sha(data), "license": lic,
            "redistributable": redistributable, "source": f"https://example.invalid/{Path(file).name}",
            "notes": ""}


def registry(kareem_ok=True, amy_ok=True):
    return {"version": 2, "models": [
        entry("whisper-base", "stt", "stt/ggml-base.bin", BASE),
        entry("whisper-small", "stt", "stt/ggml-small.bin", SMALL),
        entry("piper-en_US-amy-medium", "tts", "tts/en_US-amy-medium.onnx", AMY,
              "CC-BY-4.0" if amy_ok else "CC-BY-NC-4.0", amy_ok),
        entry("piper-ar_JO-kareem-medium", "tts", "tts/ar_JO-kareem-medium.onnx", KAREEM,
              "CC-BY-4.0" if kareem_ok else "CC-BY-NC-4.0", kareem_ok),
        entry("oww-hey-jarvis", "wake", "wake/hey_jarvis_v0.1.onnx", WAKE, "CC-BY-NC-SA-4.0", False),
    ]}


LIST = [("whisper-base", False), ("whisper-small", False),
        ("piper-en_US-amy-medium", False), ("piper-ar_JO-kareem-medium", True)]


class StageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.mirror = self.tmp / "mirror"
        self.mirror.mkdir()
        for name, data in [("ggml-base.bin", BASE), ("ggml-small.bin", SMALL),
                           ("en_US-amy-medium.onnx", AMY), ("ar_JO-kareem-medium.onnx", KAREEM)]:
            (self.mirror / name).write_bytes(data)
        self.configs = self.tmp / "configs"
        self.configs.mkdir()
        for name in ("en_US-amy-medium.onnx.json", "ar_JO-kareem-medium.onnx.json"):
            (self.configs / name).write_text('{"audio": {"sample_rate": 22050}}')
        self.stage_dir = self.tmp / "stage"
        self.voice = self.stage_dir / "usr/share/jarvis/voice"

    def run_stage(self, reg, wanted=LIST, mirror="default"):
        chosen, warnings = voice_stage.select(reg, wanted)
        manifest = voice_stage.stage(self.stage_dir, reg, chosen, self.configs, self.tmp / "cache",
                                     self.mirror if mirror == "default" else mirror)
        return manifest, warnings

    def test_full_stage(self):
        manifest, warnings = self.run_stage(registry())
        self.assertEqual(warnings, [])
        for rel in ("stt/ggml-base.bin", "stt/ggml-small.bin", "tts/en_US-amy-medium.onnx",
                    "tts/en_US-amy-medium.onnx.json", "tts/ar_JO-kareem-medium.onnx",
                    "tts/ar_JO-kareem-medium.onnx.json", "manifest.json"):
            self.assertTrue((self.voice / rel).is_file(), rel)
        self.assertFalse((self.voice / "wake").exists())
        on_disk = json.loads((self.voice / "manifest.json").read_text())
        self.assertEqual(on_disk, manifest)
        stt = {m["id"]: m for m in manifest["stt"]}
        self.assertEqual(stt["whisper-base"]["ramMaxBytes"], 8 * 1024**3)
        self.assertEqual(stt["whisper-small"]["ramMinBytes"], 8 * 1024**3 + 1)
        self.assertEqual(stt["whisper-base"]["path"], "/usr/share/jarvis/voice/stt/ggml-base.bin")
        tts = {m["id"]: m for m in manifest["tts"]}
        self.assertEqual(tts["piper-en_US-amy-medium"]["lang"], "en")
        self.assertEqual(tts["piper-ar_JO-kareem-medium"]["lang"], "ar")
        self.assertEqual(tts["piper-en_US-amy-medium"]["config"],
                         "/usr/share/jarvis/voice/tts/en_US-amy-medium.onnx.json")
        doc = (self.stage_dir / "usr/share/doc/jarvis-voice-models/MODELS").read_text()
        self.assertIn("piper-ar_JO-kareem-medium: CC-BY-4.0", doc)
        self.assertEqual((self.voice / "stt/ggml-base.bin").stat().st_mode & 0o777, 0o644)

    def test_optional_non_redistributable_voice_is_skipped(self):
        manifest, warnings = self.run_stage(registry(kareem_ok=False))
        self.assertEqual([m["id"] for m in manifest["tts"]], ["piper-en_US-amy-medium"])
        self.assertTrue(any("piper-ar_JO-kareem-medium" in w for w in warnings), warnings)
        self.assertFalse((self.voice / "tts/ar_JO-kareem-medium.onnx").exists())

    def test_required_non_redistributable_fails(self):
        with self.assertRaisesRegex(ValueError, "piper-en_US-amy-medium.*not redistributable"):
            self.run_stage(registry(amy_ok=False))

    def test_required_missing_fails(self):
        with self.assertRaisesRegex(ValueError, "whisper-tiny.*not in"):
            self.run_stage(registry(), [("whisper-tiny", False)])

    def test_wake_model_never_ships_even_optional(self):
        with self.assertRaisesRegex(ValueError, "wake"):
            self.run_stage(registry(), LIST + [("oww-hey-jarvis", True)])

    def test_wrong_bytes_fail_and_name_the_model(self):
        (self.mirror / "ggml-small.bin").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "whisper-small: sha256"):
            self.run_stage(registry())

    def test_missing_piper_config_fails(self):
        (self.configs / "en_US-amy-medium.onnx.json").unlink()
        with self.assertRaisesRegex(ValueError, "Piper config"):
            self.run_stage(registry())

    def test_needs_stt_and_tts(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            self.run_stage(registry(), [("whisper-base", False)])

    def test_cache_hit_needs_no_network_and_bad_cache_is_deleted(self):
        reg = registry()
        cache = self.tmp / "cache"
        m = reg["models"][0]
        good = cache / m["sha256"] / "ggml-base.bin"
        good.parent.mkdir(parents=True)
        good.write_bytes(BASE)
        self.assertEqual(voice_stage.fetch(m, cache, None), good)
        good.write_bytes(b"corrupt")
        with self.assertRaises(ValueError):
            voice_stage.fetch(m, cache, None)
        self.assertFalse(good.exists())

    def test_read_list(self):
        f = self.tmp / "models.list"
        f.write_text("# comment\nwhisper-base\n\npiper-x ?  # optional\n")
        self.assertEqual(voice_stage.read_list(f), [("whisper-base", False), ("piper-x", True)])
        f.write_text("whisper-base maybe\n")
        with self.assertRaises(ValueError):
            voice_stage.read_list(f)


class CommittedListTest(unittest.TestCase):
    def test_contract_models_are_listed_and_registered(self):
        wanted = dict(voice_stage.read_list(voice_stage.DEFAULT_LIST))
        for mid in ("whisper-base", "whisper-small", "piper-en_US-amy-medium"):
            self.assertIs(wanted.get(mid), False, mid)
        self.assertIs(wanted.get("piper-ar_JO-kareem-medium"), True)
        reg = voice_stage.voice.load(None)
        by_id = {m["id"]: m for m in reg["models"]}
        for mid, optional in wanted.items():
            if not optional:
                self.assertTrue(by_id[mid]["redistributable"], mid)
        self.assertFalse(any(by_id[m]["kind"] == "wake" for m in wanted if m in by_id))


if __name__ == "__main__":
    unittest.main()
