#!/usr/bin/env python3
"""Local vision model for computer use (v1.1 contracts §4.12): "add at most one
vision-capable local model if a tool-calling + vision probe passes (else none
in v1.1, cloud-only)".

  vision_pick.py check                               validate vision-candidates.json
  vision_pick.py record --result F --run-id N [--date YYYY-MM-DD]
                                                     store one probe result (os-models.yml artifact)
  vision_pick.py pick                                print the candidate to add, or "none"
  vision_pick.py apply                               add it to catalog.json (vision: true)
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

MODELS = Path(__file__).resolve().parents[1]
CATALOG = MODELS / "catalog.json"
CANDIDATES = MODELS / "vision-candidates.json"
TIERS = ("small", "medium", "large", "gpu")
STATUSES = ("untested", "passed", "failed")
KEYS = {"id", "ollamaTag", "displayName", "sizeBytes", "minRamGB", "tier", "languages", "probe"}
PROBE_KEYS = {"status", "runId", "date", "detail"}
MAX_RAM_GB = 16  # the recommended 16 GB class must run it (M2 design §5.3 tiers)


def check(candidates: dict) -> list[str]:
    p: list[str] = []
    if not isinstance(candidates, dict) or set(candidates) != {"version", "models"}:
        return ["top level must be exactly {version, models}"]
    if type(candidates["version"]) is not int or candidates["version"] != 1:
        p.append("version must be 1")
    if not isinstance(candidates["models"], list) or not candidates["models"]:
        return p + ["models must be a non-empty list"]
    seen_ids, seen_tags = set(), set()
    for i, c in enumerate(candidates["models"]):
        where = f"models[{i}]"
        if not isinstance(c, dict) or set(c) != KEYS:
            p.append(f"{where}: keys must be {sorted(KEYS)}")
            continue
        for key, pattern, seen in [("id", r"[a-z0-9][a-z0-9.-]*", seen_ids),
                                    ("ollamaTag", r"[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*", seen_tags)]:
            value = c[key]
            if not isinstance(value, str) or not re.fullmatch(pattern, value):
                p.append(f"{where}: invalid {key}")
            elif value in seen:
                p.append(f"{where}: duplicate {key} {value}")
            else:
                seen.add(value)
        if not isinstance(c["displayName"], str) or not c["displayName"].strip():
            p.append(f"{where}: displayName is empty")
        if type(c["sizeBytes"]) is not int or c["sizeBytes"] < 100_000_000:
            p.append(f"{where}: sizeBytes must be an integer >= 100 MB")
        if type(c["minRamGB"]) is not int or not 4 <= c["minRamGB"] <= 512:
            p.append(f"{where}: minRamGB must be an integer 4-512")
        if c["tier"] not in TIERS:
            p.append(f"{where}: tier must be one of {TIERS}")
        if (type(c["sizeBytes"]) is int and type(c["minRamGB"]) is int
                and c["tier"] != "gpu" and c["sizeBytes"] > c["minRamGB"] * 1024**3 * 3 // 4):
            p.append(f"{where}: model is larger than 75% of minRamGB")
        if not isinstance(c["languages"], list) or not c["languages"] or not all(
                isinstance(lang, str) and re.fullmatch(r"[a-z]{2,3}(-[A-Z]{2})?", lang)
                for lang in c["languages"]):
            p.append(f"{where}: languages must be BCP 47 codes")
        probe = c["probe"]
        if not isinstance(probe, dict) or set(probe) != PROBE_KEYS:
            p.append(f"{where}: probe must be {sorted(PROBE_KEYS)}")
            continue
        if probe["status"] not in STATUSES:
            p.append(f"{where}: probe.status must be one of {STATUSES}")
        if not isinstance(probe["detail"], str):
            p.append(f"{where}: probe.detail must be text")
        if probe["status"] == "untested":
            if probe["runId"] is not None or probe["date"] is not None:
                p.append(f"{where}: untested probe must have no runId or date")
        else:
            if type(probe["runId"]) is not int or probe["runId"] <= 0:
                p.append(f"{where}: probe.runId must be a positive integer")
            try:
                datetime.date.fromisoformat(probe["date"])
            except (TypeError, ValueError):
                p.append(f"{where}: probe.date must be YYYY-MM-DD")
    return p


def record(candidates: dict, result: dict, run_id: int, date: str) -> dict:
    problems = check(candidates)
    if problems:
        raise ValueError("; ".join(problems))
    if type(run_id) is not int or run_id <= 0:
        raise ValueError("run_id must be a positive integer")
    datetime.date.fromisoformat(date)
    if result.get("status") not in ("passed", "failed"):
        raise ValueError("probe result status must be passed or failed")
    trials = result.get("trials", [])
    if not isinstance(trials, list) or not all(isinstance(t, dict) and type(t.get("hit")) is bool for t in trials):
        raise ValueError("probe trials must contain boolean hits")
    if result["status"] == "passed" and (
            result.get("contextSize") != 8192
            or not isinstance(result.get("capabilities"), list)
            or not {"tools", "vision"} <= set(result["capabilities"])
            or len(trials) != 3 or sum(t["hit"] for t in trials) < 2):
        raise ValueError("passing evidence needs tools + vision at 8192 tokens and 2/3 hits")
    out = json.loads(json.dumps(candidates))
    for c in out["models"]:
        if c["ollamaTag"] == result.get("tag"):
            trials = result.get("trials", [])
            hits = sum(1 for t in trials if t.get("hit"))
            c["probe"] = {"status": "passed" if result.get("status") == "passed" else "failed",
                          "runId": run_id, "date": date, "detail": f"{hits}/{len(trials)} clicks on target"}
            return out
    raise ValueError(f"{result.get('tag')!r} is not a vision candidate")


def pick(candidates: dict, max_ram_gb: int = MAX_RAM_GB) -> dict | None:
    problems = check(candidates)
    if problems:
        raise ValueError("; ".join(problems))
    passed = [c for c in candidates["models"]
              if c["probe"]["status"] == "passed" and c["minRamGB"] <= max_ram_gb and c["tier"] != "gpu"]
    passed.sort(key=lambda c: (c["minRamGB"], c["sizeBytes"]))
    return passed[0] if passed else None


def apply(catalog: dict, candidate: dict) -> dict:
    problems = check({"version": 1, "models": [candidate]})
    if problems:
        raise ValueError("; ".join(problems))
    if candidate["tier"] == "gpu":
        raise ValueError("vision candidates have no minVramGB; cannot apply a GPU-only model")
    if any(m["id"] == candidate["id"] or m["ollamaTag"] == candidate["ollamaTag"]
           for m in catalog["models"]):
        raise ValueError("candidate identity already exists in the catalog")
    if candidate["probe"]["status"] != "passed":
        raise ValueError(f"{candidate['ollamaTag']} has no passed vision probe")
    if any(m.get("vision") is True for m in catalog["models"]):
        raise ValueError("the catalog already has a local vision model (at most one, v1.1 contracts §4.12)")
    entry = {
        "id": candidate["id"], "ollamaTag": candidate["ollamaTag"], "displayName": candidate["displayName"],
        "sizeBytes": candidate["sizeBytes"], "minRamGB": candidate["minRamGB"], "minVramGB": None,
        "tier": candidate["tier"], "toolCalling": "verified", "languages": candidate["languages"],
        "recommendedFor": "Lets Jarvis see the screen and use apps for you (computer use)",
        "role": "main", "vision": True,
    }
    out = json.loads(json.dumps(catalog))
    rank = TIERS.index(entry["tier"])
    at = len(out["models"])
    for i, m in enumerate(out["models"]):
        if TIERS.index(m["tier"]) > rank:
            at = i
            break
    out["models"].insert(at, entry)
    return out


def dump(catalog: dict) -> str:
    """catalog.json's own style: one key per line, arrays inline."""
    lines = ["{", f'  "version": {json.dumps(catalog["version"])},', '  "models": [']
    models = catalog["models"]
    for i, m in enumerate(models):
        lines.append("    {")
        items = list(m.items())
        for j, (k, v) in enumerate(items):
            lines.append(f"      {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}{',' if j < len(items) - 1 else ''}")
        lines.append("    }" + ("," if i < len(models) - 1 else ""))
    lines += ["  ]", "}"]
    return "\n".join(lines) + "\n"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    r = sub.add_parser("record")
    r.add_argument("--result", type=Path, required=True)
    r.add_argument("--run-id", type=int, required=True)
    r.add_argument("--date", default=datetime.date.today().isoformat())
    sub.add_parser("pick")
    sub.add_parser("apply")
    a = p.parse_args()
    candidates = json.loads(CANDIDATES.read_text())
    if a.cmd == "check":
        problems = check(candidates)
        for line in problems:
            print(f"vision-candidates.json: {line}", file=sys.stderr)
        return 1 if problems else 0
    if a.cmd == "record":
        out = record(candidates, json.loads(a.result.read_text()), a.run_id, a.date)
        CANDIDATES.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
        return 0
    chosen = pick(candidates)
    if a.cmd == "pick":
        print(chosen["ollamaTag"] if chosen else "none")
        return 0
    if chosen is None:
        print("no candidate passed the vision probe: v1.1 stays cloud-only for computer use", file=sys.stderr)
        return 1
    CATALOG.write_text(dump(apply(json.loads(CATALOG.read_text()), chosen)))
    print(f"added {chosen['ollamaTag']} with vision: true")
    return 0


if __name__ == "__main__":
    sys.exit(main())
