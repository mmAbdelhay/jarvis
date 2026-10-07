"""Schema test for os/models/catalog.json (contracts §4)."""
from __future__ import annotations

import copy
import json
import re
import unittest
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / "catalog.json"
TIERS = ("small", "medium", "large", "gpu")
KEYS = {"id", "ollamaTag", "displayName", "sizeBytes", "minRamGB", "minVramGB", "tier",
        "toolCalling", "languages", "recommendedFor"}
ID = re.compile(r"^[a-z0-9][a-z0-9.-]*$")
TAG = re.compile(r"^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$")
LANG = re.compile(r"^[a-z]{2,3}(-[A-Z]{2})?$")


def is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate(catalog) -> list[str]:
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
            p.append(f"{where} keys {sorted(set(m) ^ KEYS)} differ from contracts §4"); continue
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
        if is_int(m["sizeBytes"]) and is_int(m["minRamGB"]) and m["tier"] != "gpu" and m["sizeBytes"] > m["minRamGB"] * 1024**3 * 0.75:
            p.append(f"{where}: model is larger than 75% of minRamGB")
    if not any(isinstance(m, dict) and m.get("tier") == "small" for m in models):
        p.append("at least one small-tier model (8 GB machines) is required")
    return p


class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads(CATALOG.read_text())

    def test_catalog_is_valid(self):
        self.assertEqual(validate(self.catalog), [])

    def test_tiers_ordered_small_to_gpu(self):
        order = [TIERS.index(m["tier"]) for m in self.catalog["models"]]
        self.assertEqual(order, sorted(order), "models are listed small → gpu (installer shows them in order)")

    def test_validator_catches_contract_breaks(self):
        good = self.catalog
        cases = {
            "extra key": lambda c: c["models"][0].update(extra=1),
            "missing key": lambda c: c["models"][0].pop("recommendedFor"),
            "unverified": lambda c: c["models"][0].update(toolCalling="untested"),
            "bad tier": lambda c: c["models"][0].update(tier="huge"),
            "bool size": lambda c: c["models"][0].update(sizeBytes=True),
            "dup id": lambda c: c["models"].append(copy.deepcopy(c["models"][0])),
            "tag without version": lambda c: c["models"][0].update(ollamaTag="qwen3"),
            "gpu without vram": lambda c: c["models"][-1].update(tier="gpu", minVramGB=None),
            "string version": lambda c: c.update(version="1"),
            "empty langs": lambda c: c["models"][0].update(languages=[]),
        }
        for name, mutate in cases.items():
            c = copy.deepcopy(good)
            mutate(c)
            self.assertNotEqual(validate(c), [], name)


if __name__ == "__main__":
    unittest.main()
