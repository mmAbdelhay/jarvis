#!/usr/bin/env python3
"""GitHub Actions matrix for the catalog probe: hosted runners take models up
to --max-hosted-bytes; bigger ones go to --large-runner or are skipped."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / "catalog.json"


def build(catalog: dict, max_hosted: int, large_runner: str) -> dict:
    rows = []
    for m in catalog["models"]:
        runner = "ubuntu-24.04" if m["sizeBytes"] <= max_hosted else large_runner
        rows.append({"id": m["id"], "tag": m["ollamaTag"], "sizeBytes": m["sizeBytes"], "runner": runner})
    return {"include": rows}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("catalog", nargs="?", type=Path, default=CATALOG)
    p.add_argument("--max-hosted-bytes", type=int, default=12 << 30)
    p.add_argument("--large-runner", default="skip")
    a = p.parse_args()
    print(json.dumps(build(json.loads(a.catalog.read_text()), a.max_hosted_bytes, a.large_runner), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
