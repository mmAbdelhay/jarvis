#!/usr/bin/env python3
"""GitHub Actions matrix for the catalog probe: hosted runners take models up
to --max-hosted-bytes whose minRamGB fits the hosted runner (--hosted-ram-gb,
16 GB on ubuntu-24.04); the rest go to --large-runner or are skipped. A model
needing more RAM than the runner has also runs far below its target speed on
the runner's 4 CPUs, so the probe's 30 s budget would measure the runner,
not the model (qwen3:14b timed out there)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / "catalog.json"


def build(catalog: dict, max_hosted: int, large_runner: str, hosted_ram_gb: int = 16) -> dict:
    rows = []
    for m in catalog["models"]:
        hosted = m["sizeBytes"] <= max_hosted and m.get("minRamGB", 0) <= hosted_ram_gb
        runner = "ubuntu-24.04" if hosted else large_runner
        rows.append({"id": m["id"], "tag": m["ollamaTag"], "sizeBytes": m["sizeBytes"], "runner": runner})
    return {"include": rows}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("catalog", nargs="?", type=Path, default=CATALOG)
    p.add_argument("--max-hosted-bytes", type=int, default=12 << 30)
    p.add_argument("--hosted-ram-gb", type=int, default=16)
    p.add_argument("--large-runner", default="skip")
    a = p.parse_args()
    matrix = build(json.loads(a.catalog.read_text()), a.max_hosted_bytes, a.large_runner, a.hosted_ram_gb)
    print(json.dumps(matrix, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
