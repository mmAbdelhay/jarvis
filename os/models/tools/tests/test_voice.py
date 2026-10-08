"""Voice-model license registry and gate (M2.5 contracts §4, design §3.6)."""
from __future__ import annotations

import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import voice  # noqa: E402


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


STT = b"fake-stt-model"
WAKE = b"fake-hey-jarvis"


def fixture_registry() -> dict:
    return {"version": 1, "models": [
        {"id": "whisper-base", "kind": "stt", "file": "stt/ggml-base.bin", "sha256": sha(STT),
         "license": "MIT", "redistributable": True,
         "source": "https://example.invalid/ggml-base.bin", "notes": ""},
        {"id": "oww-hey-jarvis", "kind": "wake", "file": "wake/hey_jarvis_v0.1.onnx", "sha256": sha(WAKE),
         "license": "CC-BY-NC-SA-4.0", "redistributable": False,
         "source": "https://example.invalid/hey_jarvis_v0.1.onnx", "notes": "not shipped"},
    ]}


class RegistryFileTest(unittest.TestCase):
    def setUp(self):
        self.reg = voice.load(None)

    def test_registry_is_valid(self):
        self.assertEqual(voice.validate(self.reg), [])

    def test_seed_policy(self):
        models = self.reg["models"]
        self.assertTrue(any(m["kind"] == "stt" and m["redistributable"] for m in models),
                        "at least one redistributable STT model (whisper.cpp, MIT)")
        tts = [m for m in models if m["kind"] == "tts"]
        self.assertTrue(tts, "at least one Piper voice")
        by_id = {m["id"]: m for m in tts}
        amy = by_id["piper-en_US-amy-medium"]
        self.assertEqual((amy["license"], amy["redistributable"]), ("CC-BY-4.0", True))
        self.assertFalse(by_id["piper-ar_JO-kareem-medium"]["redistributable"])
        # Arabic is registered for config coverage, but may ship only once its
        # redistribution license is verified; the scan gate enforces the flag.
        hey = [m for m in models if m["id"] == "oww-hey-jarvis"]
        self.assertEqual(len(hey), 1, "the hey-jarvis model is listed so the gate refuses it")
        self.assertEqual((hey[0]["kind"], hey[0]["redistributable"]), ("wake", False))


class ValidateTest(unittest.TestCase):
    def assert_bad(self, mutate, needle=""):
        reg = fixture_registry()
        mutate(reg)
        problems = voice.validate(reg)
        self.assertNotEqual(problems, [])
        if needle:
            self.assertTrue(any(needle in p for p in problems), problems)

    def test_fixture_is_valid(self):
        self.assertEqual(voice.validate(fixture_registry()), [])

    def test_contract_breaks(self):
        m0 = lambda r: r["models"][0]  # noqa: E731
        self.assert_bad(lambda r: r.update(version="1"), "version")
        self.assert_bad(lambda r: r.update(version=True), "version")
        self.assert_bad(lambda r: m0(r).update(extra=1), "keys")
        self.assert_bad(lambda r: m0(r).pop("notes"), "keys")
        self.assert_bad(lambda r: m0(r).update(kind="music"), "kind")
        self.assert_bad(lambda r: m0(r).update(file="tts/ggml-base.bin"), "stt/")
        self.assert_bad(lambda r: m0(r).update(file="stt/../x.bin"), "file")
        self.assert_bad(lambda r: m0(r).update(sha256=None), "voice_pin.py")
        self.assert_bad(lambda r: m0(r).update(sha256="A" * 64), "sha256")
        self.assert_bad(lambda r: m0(r).update(source="http://example.invalid/x"), "https")
        self.assert_bad(lambda r: m0(r).update(redistributable="yes"), "redistributable")
        self.assert_bad(lambda r: r["models"].append(copy.deepcopy(r["models"][0])), "duplicate")

    def test_license_and_flag_must_agree(self):
        m0 = lambda r: r["models"][0]  # noqa: E731
        self.assert_bad(lambda r: m0(r).update(license="UNVERIFIED"), "license")
        self.assert_bad(lambda r: m0(r).update(license="CC-BY-NC-4.0"), "redistributable")
        self.assert_bad(lambda r: r["models"][1].update(redistributable=True), "redistributable")


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.reg = fixture_registry()

    def put(self, rel: str, data: bytes) -> Path:
        p = self.tmp / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return p

    def test_scan_registered_model_passes(self):
        self.put("usr/share/jarvis/voice/stt/ggml-base.bin", STT)
        self.put("usr/share/jarvis/voice/stt/LICENSE", b"MIT")
        self.put("usr/share/doc/foo/README", b"text")
        self.assertEqual(voice.scan(self.tmp, self.reg), [])

    def test_scan_swapped_bytes_at_registered_path(self):
        self.put("usr/share/jarvis/voice/stt/ggml-base.bin", b"other bytes")
        problems = voice.scan(self.tmp, self.reg)
        self.assertTrue(any("sha256" in p for p in problems), problems)

    def test_scan_unregistered_model_anywhere(self):
        self.put("usr/lib/x/voice.tflite", b"unknown")
        problems = voice.scan(self.tmp, self.reg)
        self.assertTrue(any("usr/lib/x/voice.tflite" in p and "not in" in p for p in problems), problems)

    def test_scan_unregistered_file_in_voice_dir(self):
        self.put("usr/share/jarvis/voice/tts/mystery.bin", b"??")
        self.assertNotEqual(voice.scan(self.tmp, self.reg), [])

    def test_scan_non_redistributable_bytes_renamed(self):
        self.put("opt/x/renamed.onnx", WAKE)
        problems = voice.scan(self.tmp, self.reg)
        self.assertTrue(any("opt/x/renamed.onnx" in p and "CC-BY-NC-SA-4.0" in p for p in problems), problems)

    def test_scan_non_redistributable_bytes_in_voice_dir_any_name(self):
        self.put("usr/share/jarvis/voice/wake/model.dat", WAKE)
        self.assertNotEqual(voice.scan(self.tmp, self.reg), [])

    def test_scan_non_redistributable_bytes_hidden_by_name(self):
        for rel in ("opt/x/model.dat", "usr/share/jarvis/voice/wake/LICENSE.bin",
                    "usr/share/jarvis/voice/wake/notes.txt", "run/x.onnx"):
            with self.subTest(rel=rel):
                p = self.put(rel, WAKE)
                problems = voice.scan(self.tmp, self.reg)
                self.assertTrue(any(rel in x and "CC-BY-NC-SA-4.0" in x for x in problems), problems)
                p.unlink()

    def test_scan_non_redistributable_stem_other_format(self):
        self.put("usr/lib/y/hey_jarvis_v0.1.tflite", b"different bytes, same model")
        problems = voice.scan(self.tmp, self.reg)
        self.assertTrue(any("oww-hey-jarvis" in p for p in problems), problems)

    def test_scan_piper_config_companion_is_metadata(self):
        reg = fixture_registry()
        reg["models"].append({"id": "piper-x", "kind": "tts", "file": "tts/en_US-x-medium.onnx",
                              "sha256": sha(b"voice"), "license": "CC0-1.0", "redistributable": True,
                              "source": "https://example.invalid/x.onnx", "notes": ""})
        self.put("usr/share/jarvis/voice/tts/en_US-x-medium.onnx", b"voice")
        self.put("usr/share/jarvis/voice/tts/en_US-x-medium.onnx.json", b"{}")
        self.put("usr/share/jarvis/voice/tts/MODEL_CARD", b"card")
        self.assertEqual(voice.scan(self.tmp, reg), [])

    def test_scan_ignores_symlinks_and_proc(self):
        target = self.put("usr/share/jarvis/voice/stt/ggml-base.bin", STT)
        (self.tmp / "usr/lib").mkdir(parents=True, exist_ok=True)
        (self.tmp / "usr/lib/link.onnx").symlink_to(target)
        self.put("proc/1/fake.onnx", b"not a file in an image")
        self.assertEqual(voice.scan(self.tmp, self.reg), [])

    @unittest.skipUnless(shutil.which("dpkg-deb"), "needs dpkg-deb (run via os/packaging/dev/trixie.sh)")
    def test_scan_debs_names_the_package(self):
        root = self.tmp / "pkg"
        (root / "DEBIAN").mkdir(parents=True)
        (root / "DEBIAN/control").write_text(
            "Package: evil-voice\nVersion: 1\nArchitecture: all\nMaintainer: T <t@example.invalid>\nDescription: t\n")
        (root / "usr/share/jarvis/voice/wake").mkdir(parents=True)
        (root / "usr/share/jarvis/voice/wake/hey_jarvis_v0.1.onnx").write_bytes(WAKE)
        debs = self.tmp / "debs"
        debs.mkdir()
        subprocess.run(["dpkg-deb", "--root-owner-group", "-b", str(root), str(debs / "evil-voice_1_all.deb")],
                       check=True, capture_output=True)
        problems = voice.scan_debs(debs, self.reg)
        self.assertTrue(any(p.startswith("evil-voice_1_all.deb:") for p in problems), problems)


class CliTest(unittest.TestCase):
    def test_scan_cli_exit_codes(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        reg = tmp / "voice.json"
        reg.write_text(json.dumps(fixture_registry()))
        tree = tmp / "tree"
        (tree / "opt").mkdir(parents=True)
        tool = Path(voice.__file__)
        ok = subprocess.run([sys.executable, str(tool), "scan", str(tree), "--registry", str(reg)], capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        (tree / "opt/renamed.onnx").write_bytes(WAKE)
        bad = subprocess.run([sys.executable, str(tool), "scan", str(tree), "--registry", str(reg)], capture_output=True, text=True)
        self.assertEqual(bad.returncode, 1)
        self.assertIn("voice: opt/renamed.onnx", bad.stderr)


class M3LayoutTest(unittest.TestCase):
    """M3 contracts §5.13: models install under stt/ and tts/."""

    def test_committed_files_use_the_m3_dirs(self):
        for m in voice.load(None)["models"]:
            self.assertTrue(m["file"].startswith(voice.SUBDIR[m["kind"]] + "/"), m)
        self.assertEqual(voice.SUBDIR, {"stt": "stt", "tts": "tts", "wake": "wake"})

    def test_m25_dirs_are_refused(self):
        for old_file in ("whisper/ggml-base.bin", "piper/ggml-base.bin"):
            with self.subTest(file=old_file):
                reg = fixture_registry()
                reg["models"][0]["file"] = old_file
                self.assertTrue(any("stt" in p for p in voice.validate(reg)), voice.validate(reg))


class VoiceConfigTest(unittest.TestCase):
    """Every Piper voice ships with its committed runtime config."""

    def test_every_tts_voice_has_its_piper_config(self):
        for m in voice.load(None)["models"]:
            if m["kind"] != "tts":
                continue
            cfg = voice.tts_config(m)
            self.assertTrue(cfg.is_file(), f"{m['id']}: commit {cfg}")
            data = json.loads(cfg.read_text())
            self.assertIn("sample_rate", data["audio"], cfg)
            lang = Path(m["file"]).name.split("_", 1)[0]
            self.assertTrue(data["language"]["code"].startswith(lang), (cfg, data["language"]))

    def test_tts_config_path(self):
        m = {"file": "tts/en_US-amy-medium.onnx"}
        self.assertEqual(voice.tts_config(m, Path("/c")), Path("/c/en_US-amy-medium.onnx.json"))


if __name__ == "__main__":
    unittest.main()
