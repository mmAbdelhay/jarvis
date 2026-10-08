#!/usr/bin/env python3
"""MCP tool-registry entries and index (Rafiq M2.5 contracts §3, design §3.7).

  schema.py check-index FILE    validate a built index.json

Index file: {"version": 1, "generatedAt": "YYYY-MM-DDTHH:MM:SSZ", "validUntil": "<same, <= 30 days later>", "entries": [RegistryEntry, ...]}
sorted by id. Source files (os/registry/servers/<id>.json) are RegistryEntry
too, except that official servers carry artifact {"runtime"} only:
build_index.py fills url and sha256 from the artifact it publishes.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

PAGES = "https://mmabdelhay.github.io/jarvis-apt/"
CHANNEL_DIRS = {"stable": "registry", "testing": "registry-testing"}
TIERS = ("official", "reviewed", "community")
RUNTIMES = ("go-static", "node", "python")
RISKS = ("safe", "confirm")
ENTRY_KEYS = {"id", "name", "description", "tier", "version", "artifact", "permissions", "tools"}
ARTIFACT_KEYS = {"url", "sha256", "runtime"}
PERMISSION_KEYS = {"network", "paths"}
TOOL_KEYS = {"name", "risk"}
INDEX_KEYS = {"version", "generatedAt", "validUntil", "entries"}

# Contracts §3: the official servers, their exact tools, and whether they use the network.
OFFICIAL: dict[str, tuple[dict[str, str], bool]] = {
    "jarvis-files": ({"files.search": "safe", "files.preview": "safe"}, False),
    "jarvis-web": ({"web.fetch": "safe"}, True),
    "jarvis-clock": ({"clock.now": "safe", "clock.timer": "safe"}, False),
}
# Host tool namespaces (M1 §1, M2 §2, M2.5 §3) and the official ones. A third
# party may not reuse them: a card for "pkg.install" from a community server
# would read as a Jarvis action.
RESERVED_TOOL_PREFIXES = ("pkg.", "disk.", "updates.", "sys.", "logs.", "svc.", "net.", "hw.",
                          "registry.", "jarvis.", "memory.", "files.", "web.", "clock.")
# ReadWritePaths no server may get, nor any parent of them: Jarvis's own state
# (mcp.d holds trust tiers), keys, and files that run code at login.
PROTECTED_PATHS = ("~/.config/jarvis", "~/.local/share/jarvis", "~/.cache/jarvis", "~/.ssh", "~/.gnupg",
                   "~/.config/systemd", "~/.config/autostart", "~/.config/environment.d", "~/.config/labwc",
                   "~/.local/share/keyrings", "~/.local/bin", "~/.bashrc", "~/.bash_profile", "~/.profile",
                   "~/.zshrc", "~/.zprofile", "~/.pam_environment", "~/.xsessionrc")

ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
TOOL = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
URL = re.compile(r"^https://[A-Za-z0-9.-]+(:[0-9]+)?/\S*$")
STAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
SEGMENT = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def artifact_name(id_: str, version: str) -> str:
    return f"{id_}-{version}-linux-amd64.tar.gz"


def official_url(channel: str, id_: str, version: str) -> str:
    return f"{PAGES}{CHANNEL_DIRS[channel]}/artifacts/{id_}/{version}/{artifact_name(id_, version)}"


def _text(v, maxlen: int) -> bool:
    return isinstance(v, str) and v.strip() != "" and len(v) <= maxlen and not CONTROL.search(v)


def check_path(path) -> str | None:
    if not isinstance(path, str) or not path.startswith("~/"):
        return "must start with ~/ (home folder only)"
    if CONTROL.search(path) or "//" in path:
        return "is not a plain path"
    rest = path[2:].rstrip("/")
    if not rest:
        return "may not be the whole home folder"
    if any(seg in ("", ".", "..") for seg in rest.split("/")):
        return "may not contain . or .. segments"
    norm = "~/" + rest
    for q in PROTECTED_PATHS:
        if norm == q or norm.startswith(q + "/") or q.startswith(norm + "/"):
            return f"overlaps protected {q}"
    if any(seg.startswith(".") for seg in rest.split("/")):  # contracts §7.4: no hidden segments
        return "may not contain hidden (dot) segments"
    # Contracts §7.1 hands paths to systemd as a space-separated, quote- and %-expanding list.
    if not all(SEGMENT.match(seg) for seg in rest.split("/")):
        return "segments may only use A-Z a-z 0-9 . _ - (no spaces, %, quotes or backslashes)"
    return None


def validate_entry(e, *, source: bool = False) -> list[str]:
    if not isinstance(e, dict):
        return ["entry is not an object"]
    if set(e) != ENTRY_KEYS:
        return [f"{e.get('id', '?')}: keys {sorted(set(e) ^ ENTRY_KEYS)} differ from contracts §3"]
    eid = e["id"]
    if not isinstance(eid, str) or not ID.match(eid):
        return [f"{eid!r}: id must be 3-64 characters of a-z, 0-9 and inner '-'"]
    p: list[str] = []
    w = eid
    if not _text(e["name"], 60):
        p.append(f"{w}: name must be 1-60 printable characters")
    if not _text(e["description"], 300):
        p.append(f"{w}: description must be 1-300 printable characters")
    tier = e["tier"]
    if tier not in TIERS:
        return p + [f"{w}: tier must be one of {TIERS}"]
    if not isinstance(e["version"], str) or not VERSION.match(e["version"]):
        p.append(f"{w}: version must be MAJOR.MINOR.PATCH")

    a = e["artifact"]
    official_source = source and tier == "official"
    want = {"runtime"} if official_source else ARTIFACT_KEYS
    if not isinstance(a, dict) or set(a) != want:
        hint = " (url and sha256 of official servers are written by build_index.py)" if source and tier == "official" else ""
        p.append(f"{w}: artifact must have exactly {sorted(want)}{hint}")
        a = None
    if a is not None:
        if a["runtime"] not in RUNTIMES:
            p.append(f"{w}: artifact.runtime must be one of {RUNTIMES}")
        if not official_source:
            if not isinstance(a["url"], str) or len(a["url"]) > 500 or not URL.match(a["url"]):
                p.append(f"{w}: artifact.url must be an https URL")
            if not isinstance(a["sha256"], str) or not SHA256.match(a["sha256"]):
                p.append(f"{w}: artifact.sha256 must be 64 lowercase hex digits")

    perms = e["permissions"]
    if not isinstance(perms, dict) or set(perms) != PERMISSION_KEYS:
        p.append(f"{w}: permissions must be exactly {{network, paths}}")
        perms = None
    else:
        if not isinstance(perms["network"], bool):
            p.append(f"{w}: permissions.network must be true or false")
        paths = perms["paths"]
        if not isinstance(paths, list) or len(paths) > 8:
            p.append(f"{w}: permissions.paths must be a list of at most 8 paths")
        else:
            for path in paths:
                why = check_path(path)
                if why:
                    p.append(f"{w}: permissions.paths {path!r} {why}")
            if len({str(x) for x in paths}) != len(paths):
                p.append(f"{w}: permissions.paths has duplicates")

    tools = e["tools"]
    declared: dict[str, str] = {}
    if not isinstance(tools, list) or not 1 <= len(tools) <= 64:
        p.append(f"{w}: tools must list 1-64 tools")
        tools = []
    for i, t in enumerate(tools):
        if not isinstance(t, dict) or set(t) != TOOL_KEYS:
            p.append(f"{w}: tools[{i}] must be exactly {{name, risk}}")
            continue
        n = t["name"]
        if not isinstance(n, str) or len(n) > 64 or not TOOL.match(n):
            p.append(f"{w}: tools[{i}] name must look like area.verb (a-z, 0-9, _)")
            continue
        if t["risk"] not in RISKS:
            p.append(f"{w}: {n}: risk must be safe or confirm")
        if tier != "official" and n.startswith(RESERVED_TOOL_PREFIXES):
            p.append(f"{w}: {n}: tool namespace is reserved for Jarvis's own servers")
        if n in declared:
            p.append(f"{w}: duplicate tool {n}")
        declared[n] = t["risk"]

    if tier == "official":
        if eid not in OFFICIAL:
            p.append(f"{w}: only {sorted(OFFICIAL)} may be official")
        else:
            tools_want, net_want = OFFICIAL[eid]
            if declared != tools_want:
                p.append(f"{w}: official tools must be exactly {tools_want}")
            if perms is not None and (perms["network"] is not net_want or perms["paths"] != []):
                p.append(f"{w}: official permissions must be network={net_want}, paths=[]")
            if a is not None and a["runtime"] != "go-static":
                p.append(f"{w}: official servers are go-static")
            if a is not None and not source and VERSION.match(str(e["version"])):
                urls = {official_url(ch, eid, e["version"]) for ch in CHANNEL_DIRS}
                if a["url"] not in urls:
                    p.append(f"{w}: official artifact.url must be the Pages artifact URL ({sorted(urls)[0]})")
    elif eid.startswith("jarvis-"):
        p.append(f"{w}: ids starting with jarvis- are reserved for official servers")
    return p


def validate_index(idx) -> list[str]:
    if not isinstance(idx, dict) or set(idx) != INDEX_KEYS:
        return ["index keys must be exactly {version, generatedAt, validUntil, entries}"]
    p: list[str] = []
    if type(idx["version"]) is not int or idx["version"] != 1:
        p.append("index version must be 1")
    when = {}
    for k in ("generatedAt", "validUntil"):
        g = idx[k]
        if not isinstance(g, str) or not STAMP.match(g):
            p.append(f"{k} must be RFC 3339 UTC (YYYY-MM-DDTHH:MM:SSZ)")
            continue
        try:
            when[k] = datetime.strptime(g, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            p.append(f"{k} is not a real date")
    if len(when) == 2:
        if when["validUntil"] <= when["generatedAt"]:
            p.append("validUntil must be after generatedAt")
        elif when["validUntil"] - when["generatedAt"] > timedelta(days=30):
            p.append("validUntil must be at most 30 days after generatedAt (contracts §7.6)")
    entries = idx["entries"]
    if not isinstance(entries, list):
        return p + ["entries must be a list"]
    ids: list[str] = []
    owners: dict[str, str] = {}
    for e in entries:
        p += validate_entry(e)
        if isinstance(e, dict) and isinstance(e.get("id"), str):
            ids.append(e["id"])
            for t in e.get("tools") if isinstance(e.get("tools"), list) else []:
                if isinstance(t, dict) and isinstance(t.get("name"), str):
                    first = owners.setdefault(t["name"], e["id"])
                    if first != e["id"]:
                        p.append(f"tool {t['name']} is exposed by both {first} and {e['id']}")
    if len(set(ids)) != len(ids):
        p.append("duplicate entry ids")
    if ids != sorted(ids):
        p.append("entries must be sorted by id")
    return p


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "check-index":
        print("usage: schema.py check-index FILE", file=sys.stderr)
        return 2
    try:
        idx = json.loads(Path(argv[1]).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"schema: {exc}", file=sys.stderr)
        return 1
    problems = validate_index(idx)
    for prob in problems:
        print(f"schema: {prob}", file=sys.stderr)
    if problems:
        return 1
    print(f"schema: ok ({len(idx['entries'])} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
