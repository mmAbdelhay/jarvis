#!/usr/bin/env python3
"""Stage jarvis-voice-models (Rafiq M3 contracts §4) from os/models/voice.json.

  voice_stage.py STAGE [--list FILE] [--registry FILE] [--configs DIR]

Each listed id comes from its registry `source`, is checked against the
registry sha256 and lands at /usr/share/jarvis/voice/<file>. A required id
that is missing, not redistributable or a wake-word model fails the build;
an optional one ("<id> ?") that is missing or not redistributable is skipped
with a warning. Piper voices get their committed <voice>.onnx.json. Writes
manifest.json (read by jarvisd) and /usr/share/doc/jarvis-voice-models/MODELS,
then runs the M2.5 voice gate (voice.scan) on the staged tree.

  VOICE_CACHE_DIR  download cache (default ~/.cache/jarvis-build/voice)
  VOICE_MIRROR     take files from DIR/<basename> instead of the network (tests)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "models/tools"))
import voice  # noqa: E402

VOICE_DIR = "/usr/share/jarvis/voice"
RAM_SPLIT = 8 * 1024**3  # M3 contracts §4: base <= 8 GB RAM, small above
TIERS = {"whisper-base": {"ramMaxBytes": RAM_SPLIT}, "whisper-small": {"ramMinBytes": RAM_SPLIT + 1}}
DEFAULT_LIST = HERE.parent / "jarvis-voice-models/models.list"


def read_list(path: Path) -> list[tuple[str, bool]]:
    out = []
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) > 2 or (len(parts) == 2 and parts[1] != "?"):
            raise ValueError(f"models.list: bad line {raw!r} (expected '<id>' or '<id> ?')")
        out.append((parts[0], len(parts) == 2))
    return out


def select(reg: dict, wanted: list[tuple[str, bool]]) -> tuple[list[dict], list[str]]:
    by_id = {m["id"]: m for m in reg["models"]}
    chosen, warnings = [], []
    for mid, optional in wanted:
        m = by_id.get(mid)
        if m is not None and m["kind"] == "wake":
            raise ValueError(f"{mid}: wake-word models never ship (M3 contracts §4)")
        if m is None:
            why = "not in os/models/voice.json"
        elif not m["redistributable"]:
            why = f"not redistributable ({m['license']})"
        else:
            chosen.append(m)
            continue
        if not optional:
            raise ValueError(f"{mid}: {why}")
        warnings.append(f"skipping optional {mid}: {why}")
    return chosen, warnings


def fetch(m: dict, cache: Path, mirror: Path | None) -> Path:
    name = Path(m["file"]).name
    if mirror is not None:
        src = mirror / name
    else:
        src = cache / m["sha256"] / name
        if not src.exists():
            src.parent.mkdir(parents=True, exist_ok=True)
            part = src.with_name(name + ".part")
            req = urllib.request.Request(m["source"], headers={"User-Agent": "rafiq-voice-stage/1"})
            with urllib.request.urlopen(req, timeout=600) as r, part.open("wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            part.rename(src)
    got = voice.sha256_file(src)
    if got != m["sha256"]:
        if mirror is None:
            src.unlink()
        raise ValueError(f"{m['id']}: sha256 {got} is not the registered {m['sha256']}")
    return src


def lang_of(m: dict) -> str:
    # "tts/ar_JO-kareem-medium.onnx" -> "ar"
    return Path(m["file"]).name.split("_", 1)[0]


def stage(stage_dir: Path, reg: dict, chosen: list[dict], configs: Path, cache: Path,
          mirror: Path | None) -> dict:
    root = stage_dir / VOICE_DIR.lstrip("/")
    manifest: dict = {"version": 1, "stt": [], "tts": []}
    lines = []
    for m in chosen:
        src = fetch(m, cache, mirror)
        dest = root / m["file"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        dest.chmod(0o644)
        entry = {"id": m["id"], "path": f"{VOICE_DIR}/{m['file']}", "license": m["license"]}
        if m["kind"] == "stt":
            entry.update(TIERS.get(m["id"], {}))
            manifest["stt"].append(entry)
        else:
            cfg = voice.tts_config(m, configs)
            if not cfg.is_file():
                raise ValueError(f"{m['id']}: no Piper config {cfg} (commit it, see os/models/voice-configs)")
            cdest = dest.with_name(dest.name + ".json")
            shutil.copyfile(cfg, cdest)
            cdest.chmod(0o644)
            entry.update(config=f"{VOICE_DIR}/{m['file']}.json", lang=lang_of(m))
            manifest["tts"].append(entry)
        lines.append(f"{m['id']}: {m['license']} - {m['source']} (sha256 {m['sha256']})")
    if not manifest["stt"] or not manifest["tts"]:
        raise ValueError("need at least one stt and one tts model")
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (root / "manifest.json").chmod(0o644)
    doc = stage_dir / "usr/share/doc/jarvis-voice-models"
    doc.mkdir(parents=True, exist_ok=True)
    (doc / "MODELS").write_text("Voice models in jarvis-voice-models (os/models/voice.json):\n\n"
                                + "\n".join(lines) + "\n")
    problems = voice.scan(stage_dir, reg)
    if problems:
        raise ValueError("voice gate: " + "; ".join(problems))
    return manifest


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", type=Path)
    ap.add_argument("--list", type=Path, default=DEFAULT_LIST)
    ap.add_argument("--registry", type=Path, default=None)
    ap.add_argument("--configs", type=Path, default=voice.CONFIGS)
    a = ap.parse_args(argv)
    reg = voice.load(a.registry)
    problems = voice.validate(reg)
    for p in problems:
        print(f"voice_stage: {p}", file=sys.stderr)
    if problems:
        return 1
    default_cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "jarvis-build/voice"
    cache = Path(os.environ.get("VOICE_CACHE_DIR") or default_cache)
    mirror = Path(os.environ["VOICE_MIRROR"]) if os.environ.get("VOICE_MIRROR") else None
    try:
        chosen, warnings = select(reg, read_list(a.list))
        for w in warnings:
            print(f"voice_stage: warning: {w}", file=sys.stderr)
        manifest = stage(a.stage, reg, chosen, a.configs, cache, mirror)
    except ValueError as e:
        print(f"voice_stage: {e}", file=sys.stderr)
        return 1
    print(f"voice_stage: {len(manifest['stt'])} stt, {len(manifest['tts'])} tts", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
