#!/usr/bin/env python3
"""Voice-model license registry (Rafiq M2.5 contracts §4, design §3.6).

  voice.py validate [--registry FILE]        schema + license/flag consistency
  voice.py scan TREE [--registry FILE]       an install tree or chroot ships only registered,
                                             redistributable voice models
  voice.py scan-debs DIR [--registry FILE]   the same for every .deb in DIR (needs dpkg-deb)

Voice models install under /usr/share/jarvis/voice/<file>. The scan matches by
path, by sha256 and by file stem, so a non-redistributable model is caught
even when renamed or moved.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REGISTRY = Path(__file__).resolve().parents[1] / "voice.json"
VOICE_DIR = "usr/share/jarvis/voice"
KINDS = ("stt", "tts", "wake")
SUBDIR = {"stt": "whisper", "tts": "piper", "wake": "wake"}
KEYS = {"id", "kind", "file", "sha256", "license", "redistributable", "source", "notes"}
REDISTRIBUTABLE = frozenset({"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0",
                             "CC-BY-4.0", "CC-BY-SA-4.0", "Public-Domain"})
NOT_REDISTRIBUTABLE = frozenset({"CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "CC-BY-NC-ND-4.0", "CC-BY-ND-4.0",
                                 "Proprietary", "Blizzard-2013"})
ID = re.compile(r"^[a-z0-9][A-Za-z0-9._-]{1,79}$")
FILE = re.compile(r"^(whisper|piper|wake)/[A-Za-z0-9][A-Za-z0-9._-]*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MODEL_NAME = re.compile(r"(\.onnx|\.tflite|\.ppn|\.pv)$|^ggml-.*\.bin$")
METADATA_NAME = re.compile(r"(\.json|\.txt|\.md)$|^(LICENSE|COPYING|MODEL_CARD)")
SKIP_TOP = {"proc", "sys", "dev", "run"}


def load(path: Path | None) -> dict:
    return json.loads((path or REGISTRY).read_text())


def validate(reg) -> list[str]:
    if not isinstance(reg, dict) or set(reg) != {"version", "models"}:
        return ["top level must be exactly {version, models}"]
    p: list[str] = []
    if type(reg["version"]) is not int or reg["version"] < 1:
        p.append("version must be an integer >= 1")
    models = reg["models"]
    if not isinstance(models, list):
        return p + ["models must be a list"]
    ids, files = set(), set()
    for i, m in enumerate(models):
        if not isinstance(m, dict) or set(m) != KEYS:
            got = set(m) if isinstance(m, dict) else set()
            p.append(f"models[{i}]: keys {sorted(got ^ KEYS)} differ from contracts §4")
            continue
        w = f"models[{i}] ({m['id']})"
        if not isinstance(m["id"], str) or not ID.match(m["id"]):
            p.append(f"{w}: bad id")
        if m["id"] in ids:
            p.append(f"{w}: duplicate id")
        ids.add(m["id"])
        if m["kind"] not in KINDS:
            p.append(f"{w}: kind must be one of {KINDS}")
        elif not isinstance(m["file"], str) or not FILE.match(m["file"]) or ".." in m["file"]:
            p.append(f"{w}: file must be <whisper|piper|wake>/<name> under {VOICE_DIR}")
        elif not m["file"].startswith(SUBDIR[m["kind"]] + "/"):
            p.append(f"{w}: a {m['kind']} model lives under {SUBDIR[m['kind']]}/")
        if m["file"] in files:
            p.append(f"{w}: duplicate file")
        files.add(m["file"])
        if m["sha256"] is None:
            p.append(f"{w}: sha256 missing (run os/models/tools/voice_pin.py pin)")
        elif not isinstance(m["sha256"], str) or not SHA256.match(m["sha256"]):
            p.append(f"{w}: sha256 must be 64 lowercase hex digits")
        if not isinstance(m["redistributable"], bool):
            p.append(f"{w}: redistributable must be true or false")
        lic = m["license"]
        if lic not in REDISTRIBUTABLE | NOT_REDISTRIBUTABLE:
            p.append(f"{w}: license {lic!r} is not a known SPDX-style id (verify it from the source's license file)")
        elif isinstance(m["redistributable"], bool) and m["redistributable"] != (lic in REDISTRIBUTABLE):
            p.append(f"{w}: redistributable={m['redistributable']} contradicts license {lic}")
        if not isinstance(m["source"], str) or not m["source"].startswith("https://"):
            p.append(f"{w}: source must be an https URL")
        if not isinstance(m["notes"], str):
            p.append(f"{w}: notes must be a string")
    return p


def stem(name: str) -> str:
    # "hey_jarvis_v0.1.onnx" and "hey_jarvis_v0.1.tflite" share a stem.
    for ext in (".onnx.json", ".onnx", ".tflite", ".ppn", ".pv", ".bin"):
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _files(tree: Path):
    for dirpath, dirnames, filenames in os.walk(tree):
        if Path(dirpath) == tree:
            dirnames[:] = [d for d in dirnames if d not in SKIP_TOP]
        for name in filenames:
            path = Path(dirpath) / name
            if not path.is_symlink() and path.is_file():
                yield path


def scan(tree: Path, reg: dict) -> list[str]:
    models = reg["models"]
    banned_sha = {m["sha256"]: m for m in models if not m["redistributable"]}
    banned_stem = {stem(Path(m["file"]).name): m for m in models if not m["redistributable"]}
    registered = {f"{VOICE_DIR}/{m['file']}": m for m in models if m["redistributable"]}
    allowed_sha = {m["sha256"] for m in models if m["redistributable"]}
    problems: list[str] = []
    for path in sorted(_files(tree)):
        rel = path.relative_to(tree).as_posix()
        name = path.name
        in_voice = rel.startswith(VOICE_DIR + "/")
        hit = banned_stem.get(stem(name))
        if hit is not None:
            problems.append(f"{rel}: looks like {hit['id']} ({hit['license']}, not redistributable)")
            continue
        model_like = bool(MODEL_NAME.search(name))
        if not (in_voice or model_like):
            continue
        if in_voice and not model_like and METADATA_NAME.search(name):
            continue
        digest = sha256_file(path)
        if digest in banned_sha:
            m = banned_sha[digest]
            problems.append(f"{rel}: is {m['id']} ({m['license']}, not redistributable)")
            continue
        m = registered.get(rel)
        if m is not None:
            if digest != m["sha256"]:
                problems.append(f"{rel}: sha256 {digest} is not the registered {m['sha256']} ({m['id']})")
            continue
        if digest in allowed_sha:
            continue
        problems.append(f"{rel}: voice model not in os/models/voice.json (register it with its license, or do not ship it)")
    return problems


def scan_debs(debs_dir: Path, reg: dict) -> list[str]:
    problems: list[str] = []
    for deb in sorted(debs_dir.glob("*.deb")):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["dpkg-deb", "-x", str(deb), tmp], check=True)
            problems += [f"{deb.name}: {p}" for p in scan(Path(tmp), reg)]
    return problems


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("validate", "scan", "scan-debs"):
        sp = sub.add_parser(name)
        if name != "validate":
            sp.add_argument("path", type=Path)
        sp.add_argument("--registry", type=Path, default=None)
    args = ap.parse_args(argv)
    reg = load(args.registry)
    problems = validate(reg)
    if not problems and args.cmd == "scan":
        problems = scan(args.path, reg)
    elif not problems and args.cmd == "scan-debs":
        problems = scan_debs(args.path, reg)
    for p in problems:
        print(f"voice: {p}", file=sys.stderr)
    if problems:
        return 1
    print(f"voice: ok ({len(reg['models'])} models registered, {args.cmd})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
