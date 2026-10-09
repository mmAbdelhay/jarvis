import copy
import json
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))
import vision_pick  # noqa: E402
from test_catalog import validate  # noqa: E402

MODELS = Path(__file__).resolve().parents[2]
CATALOG = MODELS / "catalog.json"
CANDIDATES = MODELS / "vision-candidates.json"


def cand(tag, ram, size, status="untested", tier="medium"):
    return {"id": tag.replace(":", "-"), "ollamaTag": tag, "displayName": tag, "sizeBytes": size,
            "minRamGB": ram, "tier": tier, "languages": ["en"],
            "probe": {"status": status, "runId": 4242 if status != "untested" else None,
                      "date": "2026-10-12" if status != "untested" else None, "detail": ""}}


class VisionPickTest(unittest.TestCase):
    def test_repo_candidates_are_valid(self):
        self.assertEqual(vision_pick.check(json.loads(CANDIDATES.read_text())), [])

    def test_check_catches_bad_entries(self):
        good = {"version": 1, "models": [cand("a:1", 8, 3 << 30)]}
        cases = {
            "bad status": lambda c: c["models"][0]["probe"].update(status="maybe"),
            "missing probe": lambda c: c["models"][0].pop("probe"),
            "duplicate tag": lambda c: c["models"].append(copy.deepcopy(c["models"][0])),
            "bad tier": lambda c: c["models"][0].update(tier="huge"),
        }
        for name, mutate in cases.items():
            c = copy.deepcopy(good)
            mutate(c)
            self.assertNotEqual(vision_pick.check(c), [], name)

    def test_record_writes_the_probe_result(self):
        c = {"version": 1, "models": [cand("a:1", 8, 3 << 30)]}
        out = vision_pick.record(c, {"tag": "a:1", "status": "passed",
                                     "contextSize": 8192, "capabilities": ["tools", "vision"],
                                     "trials": [{"hit": True}, {"hit": True}, {"hit": False}]}, 4242, "2026-10-12")
        self.assertEqual(out["models"][0]["probe"],
                         {"status": "passed", "runId": 4242, "date": "2026-10-12", "detail": "2/3 clicks on target"})
        with self.assertRaises(ValueError):
            vision_pick.record(c, {"tag": "zzz:1", "status": "passed", "trials": []}, 1, "2026-10-12")

    def test_record_rejects_passing_claim_without_runtime_probe_evidence(self):
        c = {"version": 1, "models": [cand("a:1", 8, 3 << 30)]}
        good = {"tag": "a:1", "status": "passed", "contextSize": 8192,
                "capabilities": ["tools", "vision"],
                "trials": [{"hit": True}, {"hit": True}, {"hit": False}]}
        for field, value in [("contextSize", 4096), ("contextSize", None),
                             ("capabilities", ["vision"]), ("trials", [{"hit": True}]),
                             ("trials", [{"hit": False}] * 3)]:
            with self.subTest(field=field, value=value):
                result = dict(good, **{field: value})
                with self.assertRaises(ValueError):
                    vision_pick.record(c, result, 4242, "2026-10-12")
        self.assertEqual(vision_pick.record(c, good, 4242, "2026-10-12")
                         ["models"][0]["probe"]["status"], "passed")

    def test_check_handles_malformed_schema_and_evidence(self):
        good = {"version": 1, "models": [cand("a:1", 8, 3 << 30)]}
        for mutation in [lambda c: c.update(version=True), lambda c: c.update(models=None),
                         lambda c: c["models"][0].update(sizeBytes=True),
                         lambda c: c["models"][0].update(ollamaTag=[]),
                         lambda c: c["models"][0]["probe"].update(status="passed"),
                         lambda c: c["models"][0].update(languages=[])]:
            c = copy.deepcopy(good)
            mutation(c)
            self.assertNotEqual(vision_pick.check(c), [])

    def test_apply_refuses_duplicate_catalog_identity(self):
        catalog = json.loads(CATALOG.read_text())
        c = cand(catalog["models"][1]["ollamaTag"], 8, 3 << 30, "passed", "small")
        with self.assertRaises(ValueError):
            vision_pick.apply(catalog, c)

    def test_failed_run_replaces_previous_passing_evidence(self):
        c = {"version": 1, "models": [cand("a:1", 8, 3 << 30, "passed")]}
        out = vision_pick.record(c, {"tag": "a:1", "status": "failed", "trials": []},
                                 4243, "2026-10-13")
        self.assertIsNone(vision_pick.pick(out))
        self.assertEqual(c["models"][0]["probe"]["status"], "passed")

    def test_cli_never_applies_an_unproven_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            models = Path(tmp)
            tools = models / "tools"
            tools.mkdir()
            script = tools / "vision_pick.py"
            script.write_text(Path(vision_pick.__file__).read_text())
            catalog = models / "catalog.json"
            catalog.write_text(CATALOG.read_text())
            candidates = models / "vision-candidates.json"
            candidates.write_text(json.dumps({"version": 1, "models": [cand("a:1", 8, 3 << 30)]}))
            def run(*args):
                return subprocess.run([sys.executable, str(script), *args], capture_output=True, text=True)
            self.assertEqual(run("check").returncode, 0)
            self.assertEqual(run("pick").stdout, "none\n")
            refused = run("apply")
            self.assertEqual(refused.returncode, 1)
            self.assertIn("cloud-only", refused.stderr)
            self.assertEqual(catalog.read_text(), CATALOG.read_text())
            result = models / "result.json"
            result.write_text(json.dumps({"tag": "a:1", "status": "failed", "trials": []}))
            self.assertEqual(run("record", "--result", str(result), "--run-id", "4242",
                                 "--date", "2026-10-12").returncode, 0)
            self.assertEqual(json.loads(candidates.read_text())["models"][0]["probe"]["status"], "failed")

    def test_pick_refuses_passing_status_without_run_provenance(self):
        c = {"version": 1, "models": [cand("a:1", 8, 3 << 30, "passed")]}
        c["models"][0]["probe"]["runId"] = None
        with self.assertRaises(ValueError):
            vision_pick.pick(c)

    def test_pick_prefers_the_smallest_passed_model_that_fits_16_gb(self):
        c = {"version": 1, "models": [cand("big:1", 32, 15 << 30, "passed", "large"),
                                      cand("mid:1", 16, 6 << 30, "passed"),
                                      cand("small:1", 8, 3 << 30, "failed", "small")]}
        self.assertEqual(vision_pick.pick(c)["ollamaTag"], "mid:1")
        c["models"][1]["probe"]["status"] = "failed"
        self.assertIsNone(vision_pick.pick(c))

    def test_dump_keeps_catalog_style_byte_for_byte(self):
        text = CATALOG.read_text()
        self.assertEqual(vision_pick.dump(json.loads(text)), text)

    def test_apply_adds_one_valid_vision_model_in_tier_order(self):
        catalog = json.loads(CATALOG.read_text())
        for m in catalog["models"]:
            m["vision"] = False
        c = cand("qwen3-vl:8b", 16, 6_100_000_000, "passed")
        out = vision_pick.apply(catalog, c)
        added = [m for m in out["models"] if m["vision"]]
        self.assertEqual([m["ollamaTag"] for m in added], ["qwen3-vl:8b"])
        self.assertEqual(added[0]["role"], "main")
        self.assertEqual(validate(out, {"version": 1, "models": [c]}), [])
        tiers = [("small", "medium", "large", "gpu").index(m["tier"]) for m in out["models"]]
        self.assertEqual(tiers, sorted(tiers))
        with self.assertRaises(ValueError):
            vision_pick.apply(out, cand("other:1", 8, 3 << 30, "passed", "small"))

    def test_apply_refuses_an_unproven_candidate(self):
        catalog = json.loads(CATALOG.read_text())
        with self.assertRaises(ValueError):
            vision_pick.apply(catalog, cand("x:1", 8, 3 << 30, "untested", "small"))


if __name__ == "__main__":
    unittest.main()
