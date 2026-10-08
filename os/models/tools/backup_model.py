#!/usr/bin/env python3
"""The backup brain's weights (M4 contracts §1).

  backup_model.py pin                 network: pin the catalog's backup model
                                      to exact registry digests
  backup_model.py check               offline: the lock agrees with the catalog
  backup_model.py stage ROOT [--cache DIR] [--mirror DIR]
                                      verify every byte, then lay the model out
                                      as an Ollama store in ROOT/var/lib/ollama/models

The lock (os/models/backup-model.lock.json) makes the package reproducible: a
re-tagged model fails the build instead of shipping other weights. A cached
blob that fails its digest is deleted and fetched once more; a second
mismatch fails. --mirror is a directory laid out like OLLAMA_MODELS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parent / "catalog.json"
LOCK = HERE.parent / "backup-model.lock.json"
REGISTRY = "https://registry.ollama.ai"
HOST = "registry.ollama.ai"
ACCEPT = "application/vnd.docker.distribution.manifest.v2+json"
STORE = Path("var/lib/ollama/models")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
HEADERS = {"User-Agent": "jarvis-build/1"}
CHUNK = 1 << 20

Get = Callable[[str], bytes]
Download = Callable[[str, Path], None]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def backup_entry(catalog: dict) -> dict:
    found = [m for m in catalog.get("models", []) if isinstance(m, dict) and m.get("role") == "backup"]
    if len(found) != 1:
        raise ValueError(f"catalog must have exactly one role=backup model, found {len(found)}")
    return found[0]


def repo_and_version(tag: str) -> tuple[str, str]:
    name, version = tag.rsplit(":", 1)
    return (name if "/" in name else f"library/{name}"), version


def manifest_url(tag: str) -> str:
    repo, version = repo_and_version(tag)
    return f"{REGISTRY}/v2/{repo}/manifests/{version}"


def blob_url(tag: str, digest: str) -> str:
    repo, _ = repo_and_version(tag)
    return f"{REGISTRY}/v2/{repo}/blobs/{digest}"


def manifest_path(tag: str) -> Path:
    """Where Ollama keeps a pulled model's manifest, relative to OLLAMA_MODELS."""
    repo, version = repo_and_version(tag)
    return Path("manifests") / HOST / repo / version


def blob_name(digest: str) -> str:
    return digest.replace(":", "-")


def manifest_blobs(manifest: dict) -> list[dict]:
    return [manifest["config"], *manifest["layers"]]


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={**HEADERS, "Accept": ACCEPT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def http_download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers=HEADERS)
    part = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(req, timeout=120) as resp, part.open("wb") as out:
        shutil.copyfileobj(resp, out, CHUNK)
    part.replace(dest)


def pin(catalog: dict, get: Get = http_get) -> dict:
    tag = backup_entry(catalog)["ollamaTag"]
    raw = get(manifest_url(tag))
    manifest = json.loads(raw)
    return {
        "version": 1,
        "ollamaTag": tag,
        "manifest": {"sha256": sha256_bytes(raw), "size": len(raw)},
        "blobs": [{"digest": b["digest"], "size": b["size"], "mediaType": b["mediaType"]}
                  for b in manifest_blobs(manifest)],
    }


def check(catalog: dict, lock: dict) -> list[str]:
    try:
        entry = backup_entry(catalog)
    except ValueError as e:
        return [str(e)]
    p: list[str] = []
    if lock.get("version") != 1:
        p.append("lock version must be 1")
    if lock.get("ollamaTag") != entry["ollamaTag"]:
        p.append(f"lock pins {lock.get('ollamaTag')!r} but the catalog's backup model is "
                 f"{entry['ollamaTag']!r}: run backup_model.py pin")
    if not re.fullmatch(r"[0-9a-f]{64}", str(lock.get("manifest", {}).get("sha256", ""))):
        p.append("lock manifest.sha256 must be 64 hex digits")
    blobs = lock.get("blobs") or []
    if not blobs:
        p.append("lock lists no blobs")
    for b in blobs:
        if not DIGEST.match(str(b.get("digest", ""))):
            p.append(f"bad blob digest {b.get('digest')!r}")
        if not isinstance(b.get("size"), int) or isinstance(b.get("size"), bool) or b["size"] <= 0:
            p.append(f"blob {b.get('digest')}: size must be a positive integer")
    total = sum(b["size"] for b in blobs if isinstance(b.get("size"), int))
    if blobs and total != entry["sizeBytes"]:
        p.append(f"catalog sizeBytes {entry['sizeBytes']} != pinned blobs {total}: "
                 "run check_registry.py --fix and backup_model.py pin")
    return p


def _verified_blob(b: dict, tag: str, cache: Path, mirror: Path | None, download: Download) -> Path:
    name, want = blob_name(b["digest"]), b["digest"].split(":", 1)[1]
    if mirror is not None:
        src = mirror / "blobs" / name
        if not src.is_file() or src.stat().st_size != b["size"] or sha256_file(src) != want:
            raise ValueError(f"{b['digest']}: mirror copy {src} is missing or does not match the lock")
        return src
    cached = cache / name
    for attempt in (1, 2):
        if not cached.is_file():
            download(blob_url(tag, b["digest"]), cached)
        if cached.stat().st_size == b["size"] and sha256_file(cached) == want:
            return cached
        cached.unlink()
        if attempt == 2:
            raise ValueError(f"{b['digest']}: downloaded bytes do not match the lock "
                             "(the registry changed, or the transfer was corrupted)")
    raise AssertionError("unreachable")


def stage(root: Path, lock: dict, cache: Path, mirror: Path | None = None,
          get: Get = http_get, download: Download = http_download) -> dict:
    tag = lock["ollamaTag"]
    raw = (mirror / manifest_path(tag)).read_bytes() if mirror is not None else get(manifest_url(tag))
    if sha256_bytes(raw) != lock["manifest"]["sha256"]:
        raise ValueError(f"{tag}: registry manifest is not the pinned one (sha256 {sha256_bytes(raw)}); "
                         "re-pin deliberately with backup_model.py pin")
    listed = {(b["digest"], b["size"]) for b in manifest_blobs(json.loads(raw))}
    if listed != {(b["digest"], b["size"]) for b in lock["blobs"]}:
        raise ValueError(f"{tag}: the manifest's blobs differ from the lock")
    cache.mkdir(parents=True, exist_ok=True)
    sources = [(b, _verified_blob(b, tag, cache, mirror, download)) for b in lock["blobs"]]
    # Everything verified: only now write the store.
    store = root / STORE
    (store / "blobs").mkdir(parents=True, exist_ok=True)
    for b, src in sources:
        shutil.copyfile(src, store / "blobs" / blob_name(b["digest"]))
    mpath = store / manifest_path(tag)
    mpath.parent.mkdir(parents=True, exist_ok=True)
    mpath.write_bytes(raw)
    return {"tag": tag, "blobs": len(sources), "bytes": sum(b["size"] for b in lock["blobs"])}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", type=Path, default=CATALOG)
    ap.add_argument("--lock", type=Path, default=LOCK)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pin")
    sub.add_parser("check")
    st = sub.add_parser("stage")
    st.add_argument("root", type=Path)
    st.add_argument("--cache", type=Path, default=Path.home() / ".cache/jarvis-build/backup-model")
    st.add_argument("--mirror", type=Path)
    a = ap.parse_args(argv)
    catalog = json.loads(a.catalog.read_text())
    if a.cmd == "pin":
        lock = pin(catalog)
        a.lock.write_text(json.dumps(lock, indent=2) + "\n")
        print(f"backup_model: pinned {lock['ollamaTag']} ({len(lock['blobs'])} blobs) in {a.lock}")
        return 0
    lock = json.loads(a.lock.read_text())
    problems = check(catalog, lock)
    for line in problems:
        print(f"backup_model: {line}", file=sys.stderr)
    if problems:
        return 1
    if a.cmd == "check":
        print(f"backup_model: ok ({lock['ollamaTag']})")
        return 0
    try:
        out = stage(a.root, lock, a.cache, a.mirror)
    except (ValueError, OSError) as e:
        print(f"backup_model: {e}", file=sys.stderr)
        return 1
    print(f"backup_model: staged {out['tag']} ({out['blobs']} blobs, {out['bytes']} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
