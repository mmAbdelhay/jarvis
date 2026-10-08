#!/usr/bin/env python3
"""Pin voice.json to its sources.

  voice_pin.py pin [--all] [--registry FILE]   write sha256 for entries whose sha256 is null (or all)
  voice_pin.py cards [--registry FILE]         print the License lines of each Piper voice's MODEL_CARD

Hugging Face files use the LFS oid from the tree API (it is the sha256); any
other source is downloaded once and hashed. Licenses are never written
automatically: read `cards`, then set license/redistributable by hand.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

REGISTRY = Path(__file__).resolve().parents[1] / "voice.json"
HF = re.compile(r"^https://huggingface\.co/(?P<repo>[^/]+/[^/]+)/resolve/(?P<rev>[^/]+)/(?P<path>.+)$")
UA = {"User-Agent": "rafiq-voice-pin/1"}


def http_json(url: str):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def http_text(url: str) -> str:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def stream_sha(url: str) -> str:
    h = hashlib.sha256()
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
        for chunk in iter(lambda: r.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_sha(source: str, get_json, stream) -> str:
    m = HF.match(source)
    if m:
        path = m["path"]
        folder = path.rpartition("/")[0]
        api = f"https://huggingface.co/api/models/{m['repo']}/tree/{m['rev']}" + (f"/{folder}" if folder else "")
        for item in get_json(api):
            if item.get("path") == path:
                oid = (item.get("lfs") or {}).get("oid")
                return oid if oid else stream(source)
        raise LookupError(f"{path} not found in {m['repo']}@{m['rev']}")
    return stream(source)


def card_url(source: str) -> str | None:
    m = HF.match(source)
    if not m or m["repo"] != "rhasspy/piper-voices":
        return None
    folder = m["path"].rpartition("/")[0]
    return f"https://huggingface.co/{m['repo']}/resolve/{m['rev']}/{folder}/MODEL_CARD"


def card_licenses(text: str) -> list[str]:
    return [s.strip() for s in re.findall(r"^\s*\*\s*license:\s*(.+?)\s*$", text, re.M | re.I)]


def pin(reg: dict, all_: bool, get_json, stream) -> list[str]:
    changed = []
    for m in reg["models"]:
        if all_ or m.get("sha256") is None:
            new = resolve_sha(m["source"], get_json, stream)
            if new != m.get("sha256"):
                m["sha256"] = new
                changed.append(m["id"])
    return changed


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_pin = sub.add_parser("pin")
    p_pin.add_argument("--all", action="store_true")
    p_cards = sub.add_parser("cards")
    for sp in (p_pin, p_cards):
        sp.add_argument("--registry", type=Path, default=REGISTRY)
    args = ap.parse_args(argv)
    reg = json.loads(args.registry.read_text())
    if args.cmd == "pin":
        changed = pin(reg, args.all, http_json, stream_sha)
        args.registry.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n")
        print(f"voice_pin: pinned {', '.join(changed) or 'nothing'}")
        return 0
    for m in reg["models"]:
        url = card_url(m["source"])
        if url:
            print(f"{m['id']}: {' | '.join(card_licenses(http_text(url))) or 'NO LICENSE LINE'}  ({url})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
