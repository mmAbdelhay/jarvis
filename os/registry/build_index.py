#!/usr/bin/env python3
"""Build the tool-registry part of the Pages site (Rafiq M2.5 contracts §3).

  build_index.py --servers DIR --artifacts DIR --out SITE --channel stable|testing
                 [--previous PREV_SITE] [--generated-at RFC3339] [--verify-remote]

Writes SITE/<registry|registry-testing>/index.json and
SITE/<dir>/artifacts/<id>/<version>/<id>-<version>-linux-amd64.tar.gz.
Run it after os/repo/build-repo.sh (which recreates SITE) and before
sign-index.sh.

Published artifacts are immutable. When PREV already has <id>/<version>, its
bytes are kept (a warning says so if the new build differs; bump the version
to ship new code), and they must match the sha256 in PREV's index, which CI
verified against its signature. A version may not go backwards, and
generatedAt must increase and validUntil is generatedAt + 30 days (contracts §7.6; clients can refuse a replayed older index). The
other channel's directory and this channel's older artifacts are carried over.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import schema  # noqa: E402


def _stderr(msg: str) -> None:
    print(f"build_index: warning: {msg}", file=sys.stderr)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_sha256(url: str, limit: int = 200 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    n = 0
    req = urllib.request.Request(url, headers={"User-Agent": "rafiq-registry-build/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        for chunk in iter(lambda: r.read(1 << 20), b""):
            n += len(chunk)
            if n > limit:
                raise ValueError(f"larger than {limit} bytes")
            h.update(chunk)
    return h.hexdigest()


def verify_remote(entries, fetch=fetch_sha256) -> list[str]:
    """Download every third-party artifact once and check the pinned sha256."""
    p: list[str] = []
    for e in entries:
        if e["tier"] == "official":
            continue
        url, pinned = e["artifact"]["url"], e["artifact"]["sha256"]
        try:
            got = fetch(url)
        except Exception as exc:  # noqa: BLE001 - any failure blocks publishing
            p.append(f"{e['id']}: cannot fetch {url}: {exc}")
            continue
        if got != pinned:
            p.append(f"{e['id']}: {url} has sha256 {got}, the entry pins {pinned}")
    return p


def load_sources(d: Path) -> tuple[list[dict], list[str]]:
    files = sorted(d.glob("*.json"))
    if not files:
        return [], [f"no server entries in {d}"]
    entries, problems = [], []
    for f in files:
        try:
            e = json.loads(f.read_text())
        except json.JSONDecodeError as exc:
            problems.append(f"{f.name}: {exc}")
            continue
        if not isinstance(e, dict) or e.get("id") != f.stem:
            problems.append(f"{f.name}: id must equal the file name ({f.stem})")
            continue
        problems += [f"{f.name}: {p}" for p in schema.validate_entry(e, source=True)]
        entries.append(e)
    return entries, problems


def _ver(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def build(servers: Path, artifacts: Path, out: Path, channel: str, previous: Path | None = None,
          generated_at: str | None = None, verify=None, warn=_stderr) -> list[str]:
    entries, problems = load_sources(servers)
    if problems:
        return problems
    chan = schema.CHANNEL_DIRS[channel]
    stamp = generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    prev_index = None
    if previous is not None and (previous / chan / "index.json").is_file():
        prev_index = json.loads((previous / chan / "index.json").read_text())
    prev_sha = {(e["id"], e["version"]): e["artifact"]["sha256"] for e in (prev_index or {}).get("entries", [])}
    prev_ver = {e["id"]: e["version"] for e in (prev_index or {}).get("entries", [])}
    if prev_index is not None and stamp <= prev_index.get("generatedAt", ""):
        return [f"generatedAt {stamp} is not after the previous index's {prev_index.get('generatedAt')}"]

    built: list[dict] = []
    staged: list[tuple[Path, Path]] = []  # (source file, target) to copy once everything checks out
    for e in sorted(entries, key=lambda x: x["id"]):
        e = json.loads(json.dumps(e))
        if e["id"] in prev_ver and _ver(e["version"]) < _ver(prev_ver[e["id"]]):
            problems.append(f"{e['id']}: version {e['version']} goes backwards from published {prev_ver[e['id']]}")
            continue
        if e["tier"] == "official":
            name = schema.artifact_name(e["id"], e["version"])
            rel = Path(chan) / "artifacts" / e["id"] / e["version"] / name
            fresh = artifacts / name
            published = previous / rel if previous is not None else None
            if published is not None and published.is_file():
                digest = sha256_file(published)
                if prev_sha.get((e["id"], e["version"])) != digest:
                    problems.append(f"{e['id']} {e['version']}: published artifact does not match the previously "
                                    f"signed index; refusing to sign it again (check the Pages repo)")
                    continue
                if fresh.is_file() and sha256_file(fresh) != digest:
                    warn(f"{e['id']} {e['version']} is already published with different bytes; keeping the published "
                         f"artifact (bump the version in os/registry/servers/{e['id']}.json to ship new code)")
            elif fresh.is_file():
                digest = sha256_file(fresh)
                staged.append((fresh, out / rel))
            else:
                problems.append(f"{e['id']}: no artifact {fresh} (os/registry/package-official.sh)")
                continue
            e["artifact"] = {"url": schema.official_url(channel, e["id"], e["version"]), "sha256": digest,
                             "runtime": e["artifact"]["runtime"]}
        built.append(e)
    if problems:
        return problems
    until = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ") + timedelta(days=30)
    index = {"version": 1, "generatedAt": stamp, "validUntil": until.strftime("%Y-%m-%dT%H:%M:%SZ"), "entries": built}
    problems = schema.validate_index(index)
    if not problems and verify is not None:
        problems = verify(built)
    if problems:
        return problems

    out.mkdir(parents=True, exist_ok=True)
    if previous is not None:
        for d in schema.CHANNEL_DIRS.values():
            src = previous / d
            if not src.is_dir():
                continue
            if d == chan:
                if (src / "artifacts").is_dir():
                    shutil.copytree(src / "artifacts", out / d / "artifacts", dirs_exist_ok=True)
            else:
                shutil.copytree(src, out / d, dirs_exist_ok=True)
    for src, target in staged:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, target)
    (out / chan).mkdir(parents=True, exist_ok=True)
    (out / chan / "index.json.sig").unlink(missing_ok=True)
    (out / chan / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n")
    return []


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--servers", type=Path, required=True)
    ap.add_argument("--artifacts", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--channel", choices=sorted(schema.CHANNEL_DIRS), required=True)
    ap.add_argument("--previous", type=Path)
    ap.add_argument("--generated-at")
    ap.add_argument("--verify-remote", action="store_true")
    a = ap.parse_args(argv)
    problems = build(a.servers, a.artifacts, a.out, a.channel, previous=a.previous,
                     generated_at=a.generated_at, verify=verify_remote if a.verify_remote else None)
    for p in problems:
        print(f"build_index: {p}", file=sys.stderr)
    if problems:
        return 1
    print(f"build_index: {a.out / schema.CHANNEL_DIRS[a.channel] / 'index.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
