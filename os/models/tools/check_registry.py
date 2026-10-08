#!/usr/bin/env python3
"""Compare catalog sizeBytes with the Ollama registry manifests (sum of the
layers and config), or rewrite them with --fix."""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from typing import Callable

CATALOG = Path(__file__).resolve().parents[1] / "catalog.json"
ACCEPT = "application/vnd.docker.distribution.manifest.v2+json"


def manifest_url(tag: str) -> str:
    name, version = tag.rsplit(":", 1)
    path = name if "/" in name else f"library/{name}"
    return f"https://registry.ollama.ai/v2/{path}/manifests/{version}"


def manifest_size(manifest: dict) -> int:
    return manifest["config"]["size"] + sum(layer["size"] for layer in manifest["layers"])


def registry_size(tag: str) -> int:
    req = urllib.request.Request(manifest_url(tag), headers={"Accept": ACCEPT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return manifest_size(json.load(resp))


def compare(catalog: dict, size_of: Callable[[str], int]) -> list[str]:
    problems = []
    for m in catalog["models"]:
        actual = size_of(m["ollamaTag"])
        if actual != m["sizeBytes"]:
            problems.append(f"{m['id']}: catalog {m['sizeBytes']} != registry {actual} ({m['ollamaTag']})")
    return problems


def fix(path: Path, size_of: Callable[[str], int]) -> None:
    catalog = json.loads(path.read_text())
    for m in catalog["models"]:
        m["sizeBytes"] = size_of(m["ollamaTag"])
    path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("catalog", nargs="?", type=Path, default=CATALOG)
    p.add_argument("--fix", action="store_true")
    args = p.parse_args()
    if args.fix:
        fix(args.catalog, registry_size)
        return 0
    problems = compare(json.loads(args.catalog.read_text()), registry_size)
    for line in problems:
        print(line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
