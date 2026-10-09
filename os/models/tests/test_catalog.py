"""Schema test for os/models/catalog.json (M2 contracts §4; M4 contracts §1 role)."""
from __future__ import annotations

import copy
import json
import re
import unittest
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / "catalog.json"
VISION_CANDIDATES = Path(__file__).resolve().parents[1] / "vision-candidates.json"
TIERS = ("small", "medium", "large", "gpu")
ROLES = ("main", "backup")
KEYS = {"id", "ollamaTag", "displayName", "sizeBytes", "minRamGB", "minVramGB", "tier",
        "toolCalling", "languages", "recommendedFor", "role", "vision"}
ID = re.compile(r"^[a-z0-9][a-z0-9.-]*$")
TAG = re.compile(r"^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$")
LANG = re.compile(r"^[a-z]{2,3}(-[A-Z]{2})?$")
# M4 contracts §1: the backup brain is a ≈1–2B model that every target runs,
# in both of the OS languages.
BACKUP_MAX_BYTES = 2_500_000_000
BACKUP_LANGS = {"en", "ar"}


def is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def load_candidates() -> dict:
    """Vision probe evidence (v1.1 contracts §4.12); no file = no evidence."""
    if VISION_CANDIDATES.is_file():
        return json.loads(VISION_CANDIDATES.read_text())
    return {"version": 1, "models": []}


def validate(catalog, candidates: dict | None = None) -> list[str]:
    candidates = load_candidates() if candidates is None else candidates
    p: list[str] = []
    if not isinstance(catalog, dict) or set(catalog) != {"version", "models"}:
        return ["top level must be exactly {version, models}"]
    if not is_int(catalog["version"]) or catalog["version"] < 1:
        p.append("version must be an integer >= 1")
    models = catalog["models"]
    if not isinstance(models, list) or not models:
        return p + ["models must be a non-empty list"]
    seen_ids, seen_tags = set(), set()
    for i, m in enumerate(models):
        where = f"models[{i}]"
        if not isinstance(m, dict):
            p.append(f"{where} is not an object"); continue
        if set(m) != KEYS:
            p.append(f"{where} keys {sorted(set(m) ^ KEYS)} differ from contracts (M2 §4, M4 §1)"); continue
        where = f"{where} ({m['id']})"
        if not isinstance(m["id"], str) or not ID.match(m["id"]): p.append(f"{where}: bad id")
        if m["id"] in seen_ids: p.append(f"{where}: duplicate id")
        seen_ids.add(m["id"])
        if not isinstance(m["ollamaTag"], str) or not TAG.match(m["ollamaTag"]): p.append(f"{where}: ollamaTag must be name:tag")
        if m["ollamaTag"] in seen_tags: p.append(f"{where}: duplicate ollamaTag")
        seen_tags.add(m["ollamaTag"])
        if not isinstance(m["displayName"], str) or not m["displayName"].strip(): p.append(f"{where}: displayName empty")
        if not is_int(m["sizeBytes"]) or m["sizeBytes"] < 100_000_000: p.append(f"{where}: sizeBytes must be an integer >= 100 MB")
        if not is_int(m["minRamGB"]) or not 4 <= m["minRamGB"] <= 512: p.append(f"{where}: minRamGB must be an integer 4-512")
        if m["minVramGB"] is not None and (not is_int(m["minVramGB"]) or m["minVramGB"] < 1): p.append(f"{where}: minVramGB must be null or an integer >= 1")
        if m["tier"] not in TIERS: p.append(f"{where}: tier must be one of {TIERS}")
        if m["tier"] == "gpu" and m["minVramGB"] is None: p.append(f"{where}: gpu tier needs minVramGB")
        if m["tier"] != "gpu" and m["minVramGB"] is not None: p.append(f"{where}: only gpu tier sets minVramGB")
        if m["toolCalling"] != "verified": p.append(f"{where}: toolCalling must be \"verified\"")
        langs = m["languages"]
        if not isinstance(langs, list) or not langs or not all(isinstance(l, str) and LANG.match(l) for l in langs): p.append(f"{where}: languages must be BCP 47 codes")
        if not isinstance(m["recommendedFor"], str) or not m["recommendedFor"].strip(): p.append(f"{where}: recommendedFor empty")
        if m["role"] not in ROLES: p.append(f"{where}: role must be one of {ROLES} (M4 contracts §1)")
        if not isinstance(m["vision"], bool): p.append(f"{where}: vision must be true or false (v1.1 contracts §4.12)")
        if is_int(m["sizeBytes"]) and is_int(m["minRamGB"]) and m["tier"] != "gpu" and m["sizeBytes"] > m["minRamGB"] * 1024**3 * 0.75:
            p.append(f"{where}: model is larger than 75% of minRamGB")
    good = [m for m in models if isinstance(m, dict) and set(m) == KEYS]
    mains = [m for m in good if m["role"] == "main"]
    backups = [m for m in good if m["role"] == "backup"]
    if len(backups) != 1:
        p.append(f"exactly one backup model is required, found {len(backups)} (M4 contracts §1)")
    main_ram = [m["minRamGB"] for m in mains if is_int(m["minRamGB"])]
    for b in backups:
        w = f"backup model {b['id']}"
        if is_int(b["sizeBytes"]) and b["sizeBytes"] > BACKUP_MAX_BYTES:
            p.append(f"{w}: larger than {BACKUP_MAX_BYTES} bytes (a ≈1–2B model)")
        if b["tier"] != "small" or b["minVramGB"] is not None:
            p.append(f"{w}: must be a small, CPU-only model")
        if isinstance(b["languages"], list) and not BACKUP_LANGS <= set(b["languages"]):
            p.append(f"{w}: must handle en and ar")
        if main_ram and is_int(b["minRamGB"]) and b["minRamGB"] > min(main_ram):
            p.append(f"{w}: needs more RAM than the smallest main model; it must run on every target")
    passed = {c.get("ollamaTag") for c in candidates.get("models", [])
              if isinstance(c, dict) and isinstance(c.get("probe"), dict) and c["probe"].get("status") == "passed"}
    visions = [m for m in good if m["vision"] is True]
    if len(visions) > 1:
        p.append(f"at most one local vision model, found {len(visions)} (v1.1 contracts §3)")
    for m in visions:
        if m["ollamaTag"] not in passed:
            p.append(f"vision model {m['id']}: no passed vision probe for {m['ollamaTag']} in vision-candidates.json (v1.1 contracts §4.12)")
        if m["role"] != "main":
            p.append(f"vision model {m['id']}: must be a main model, never the backup")
    if not any(m["tier"] == "small" for m in mains):
        p.append("at least one small-tier main model (8 GB machines) is required")
    return p


def backup(c: dict) -> dict:
    return next(m for m in c["models"] if m["role"] == "backup")


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads(CATALOG.read_text())

    def test_catalog_is_valid(self):
        self.assertEqual(validate(self.catalog), [])

    def test_every_model_says_whether_it_sees(self):
        self.assertTrue(all(isinstance(m.get("vision"), bool) for m in self.catalog["models"]))
        self.assertLessEqual(sum(m["vision"] for m in self.catalog["models"]), 1)

    def test_vision_needs_probe_evidence_and_is_unique(self):
        def passed(*tags):
            return {"version": 1, "models": [{"ollamaTag": t, "probe": {"status": "passed"}} for t in tags]}
        base = copy.deepcopy(self.catalog)
        for m in base["models"]:
            m["vision"] = False
        mains = [m for m in base["models"] if m["role"] == "main"]
        one = copy.deepcopy(base)
        one["models"][1]["vision"] = True
        self.assertEqual(validate(one, passed(mains[0]["ollamaTag"])), [])
        self.assertNotEqual(validate(one, passed()), [])
        failed = {"version": 1, "models": [{"ollamaTag": mains[0]["ollamaTag"], "probe": {"status": "failed"}}]}
        self.assertNotEqual(validate(one, failed), [])
        self.assertNotEqual(validate(one), [], "missing evidence file grants no vision")
        two = copy.deepcopy(one)
        two["models"][2]["vision"] = True
        self.assertNotEqual(validate(two, passed(mains[0]["ollamaTag"], mains[1]["ollamaTag"])), [])
        seeing_backup = copy.deepcopy(base)
        backup(seeing_backup)["vision"] = True
        self.assertNotEqual(validate(seeing_backup, passed(backup(seeing_backup)["ollamaTag"])), [])

    def test_tiers_ordered_small_to_gpu(self):
        order = [TIERS.index(m["tier"]) for m in self.catalog["models"]]
        self.assertEqual(order, sorted(order), "models are listed small → gpu (installer shows them in order)")

    def test_one_backup_model_for_arabic_and_english(self):
        b = backup(self.catalog)
        self.assertEqual(b["ollamaTag"], "qwen3:1.7b")
        self.assertTrue(BACKUP_LANGS <= set(b["languages"]))
        self.assertEqual([m["role"] for m in self.catalog["models"]].count("backup"), 1)

    def test_validator_catches_contract_breaks(self):
        good = self.catalog
        cases = {
            "extra key": lambda c: c["models"][0].update(extra=1),
            "missing key": lambda c: c["models"][0].pop("recommendedFor"),
            "unverified": lambda c: c["models"][0].update(toolCalling="untested"),
            "bad tier": lambda c: c["models"][0].update(tier="huge"),
            "bool size": lambda c: c["models"][0].update(sizeBytes=True),
            "dup id": lambda c: c["models"].append(copy.deepcopy(c["models"][1])),
            "tag without version": lambda c: c["models"][0].update(ollamaTag="qwen3"),
            "gpu without vram": lambda c: c["models"][-1].update(tier="gpu", minVramGB=None),
            "string version": lambda c: c.update(version="1"),
            "empty langs": lambda c: c["models"][0].update(languages=[]),
            "no vision flag": lambda c: c["models"][1].pop("vision", None),
            "vision as text": lambda c: c["models"][1].update(vision="yes"),
            "vision as integer": lambda c: c["models"][1].update(vision=1),
            "no role": lambda c: c["models"][1].pop("role"),
            "bad role": lambda c: c["models"][1].update(role="spare"),
            "two backups": lambda c: [m for m in c["models"] if m["role"] == "main"][0].update(role="backup"),
            "no backup": lambda c: backup(c).update(role="main"),
            "big backup": lambda c: backup(c).update(sizeBytes=BACKUP_MAX_BYTES + 1, minRamGB=8),
            "backup without arabic": lambda c: backup(c).update(languages=["en"]),
            "backup on gpu": lambda c: backup(c).update(tier="gpu", minVramGB=4),
            "backup needs more RAM than mains": lambda c: backup(c).update(minRamGB=16),
        }
        for name, mutate in cases.items():
            c = copy.deepcopy(good)
            mutate(c)
            self.assertNotEqual(validate(c), [], name)


if __name__ == "__main__":
    unittest.main()
