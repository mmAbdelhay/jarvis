#!/usr/bin/env python3
"""Recipes (M4 contracts §4): validate os/recipes/*.json.

A recipe is reviewed, official-tier content that jarvisd shows as ONE card
listing every step. This validator is the build-time half of the trust
boundary: a step may only call a tool in RECIPE_TOOLS, with input inside the
limits the tool itself enforces. Nothing password-tier, no add-on server
installs, no removals, no recipes.run, no file or settings writes, and no
OS jarvis-* package (except the optional ones in OWN_PACKAGES). Contracts
§6 #2: the allowlist is pkg.install, svc.restart, apps.set_default, plus the
non-executing "note" step (an instruction shown on the card, never run).

  recipes.py validate [DIR]      one line per problem, exit 1 if any
  recipes.py sources [DIR]       "apt <pkg>" / "flatpak <app id>" lines
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

RECIPES = Path(__file__).resolve().parents[1]
SEED = ("python-dev", "node-dev", "docker", "go-dev", "media-basics", "office-basics")
EXTRA = ("jarvis-workspace",)  # M4 contracts §5
ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,31}$")
APT = re.compile(r"^[a-z0-9][a-z0-9+.-]{1,62}$")
FLATPAK = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*){2,}$")
ARABIC = re.compile(r"[؀-ۿ]")
# M1 contracts §1.2: svc.restart's system allowlist.
RESTARTABLE = {"NetworkManager", "wpa_supplicant", "systemd-resolved", "bluetooth", "cups", "docker"}
# Our own packages a recipe may install; every other jarvis-* is part of the OS.
OWN_PACKAGES = {"jarvis-workspace"}
TOP = {"id", "title", "description", "steps", "requires"}
TOP_OPTIONAL = {"available"}  # contracts §6 #15: false = listed but not installable yet
NOTE = "note"
MIME = re.compile(r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$")  # as apps.set_default
DESKTOP_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$")
STEP = {"tool", "input", "title"}
MAX_STEPS = 10
TITLE_MAX, DESC_MAX = 80, 400


def text_problems(where: str, value, limit: int) -> list[str]:
    if not isinstance(value, dict) or set(value) != {"en", "ar"}:
        return [f"{where} must be exactly {{en, ar}}"]
    p: list[str] = []
    for lang in ("en", "ar"):
        s = value[lang]
        if not isinstance(s, str) or not s.strip():
            p.append(f"{where}.{lang} is empty")
            continue
        if len(s) > limit:
            p.append(f"{where}.{lang} is longer than {limit} characters")
        if s != s.strip():
            p.append(f"{where}.{lang} has leading or trailing spaces")
    if isinstance(value["ar"], str) and value["ar"].strip() and not ARABIC.search(value["ar"]):
        p.append(f"{where}.ar has no Arabic text")
    if isinstance(value["en"], str) and ARABIC.search(value["en"]):
        p.append(f"{where}.en contains Arabic text")
    return p


def pkg_install(where: str, inp) -> list[str]:
    if not isinstance(inp, dict) or set(inp) != {"items"}:
        return [f"{where}: pkg.install input must be exactly {{items}}"]
    items = inp["items"]
    if not isinstance(items, list) or not 1 <= len(items) <= 10:
        return [f"{where}: pkg.install takes 1-10 items (M1 contracts §1.1)"]
    p: list[str] = []
    for i, it in enumerate(items):
        w = f"{where}.items[{i}]"
        if not isinstance(it, dict) or set(it) != {"source", "id"}:
            p.append(f"{w} must be exactly {{source, id}}")
            continue
        src, pid = it["source"], it["id"]
        if src == "apt":
            if not isinstance(pid, str) or not APT.match(pid):
                p.append(f"{w}: {pid!r} is not a Debian package name")
            elif pid.startswith("jarvis-") and pid not in OWN_PACKAGES:
                p.append(f"{w}: {pid} is part of the OS; recipes may not install it")
        elif src == "flatpak":
            if not isinstance(pid, str) or not FLATPAK.match(pid):
                p.append(f"{w}: {pid!r} is not a full Flatpak app ID (reverse DNS, 3+ parts)")
        else:
            p.append(f"{w}: source must be apt or flatpak")
    return p


def svc_restart(where: str, inp) -> list[str]:
    if not isinstance(inp, dict) or not {"unit"} <= set(inp) <= {"unit", "scope"}:
        return [f"{where}: svc.restart input must be {{unit, scope?}}"]
    p: list[str] = []
    if inp.get("scope", "system") != "system":
        p.append(f"{where}: recipes restart system services only")
    unit = inp["unit"]
    if not isinstance(unit, str):
        return p + [f"{where}: unit must be a string"]
    name = unit[: -len(".service")] if unit.endswith(".service") else unit
    if name not in RESTARTABLE:
        p.append(f"{where}: {unit!r} is not on the restart allowlist {sorted(RESTARTABLE)}")
    return p


def apps_set_default(where: str, inp) -> list[str]:
    if not isinstance(inp, dict) or set(inp) != {"mimeType", "appId"}:
        return [f"{where}: apps.set_default input must be exactly {{mimeType, appId}}"]
    p: list[str] = []
    mime, app = inp["mimeType"], inp["appId"]
    if not isinstance(mime, str) or not MIME.match(mime):
        p.append(f"{where}: {mime!r} is not a MIME type")
    if not isinstance(app, str) or not DESKTOP_ID.match(app):
        p.append(f"{where}: {app!r} is not an app id")
    return p


def note(where: str, inp) -> list[str]:
    if not isinstance(inp, dict) or set(inp) != {"text"}:
        return [f"{where}: note input must be exactly {{text: {{en, ar}}}}"]
    return text_problems(f"{where}.text", inp["text"], DESC_MAX)


# The ONLY tools a recipe step may call (security boundary; changes need review).
# Must stay identical to jarvisd's runtime check and S's recipecheck (contracts §6 #2).
RECIPE_TOOLS = {"pkg.install": pkg_install, "svc.restart": svc_restart,
                "apps.set_default": apps_set_default}


def validate(recipe, filename: str | None = None) -> list[str]:
    if not isinstance(recipe, dict) or not TOP <= set(recipe) <= TOP | TOP_OPTIONAL:
        return [f"{filename}: top level must be {sorted(TOP)} plus optional {sorted(TOP_OPTIONAL)} (M4 contracts §4, §6)"]
    rid = recipe["id"]
    w = str(rid)
    p: list[str] = []
    if not isinstance(rid, str) or not ID.match(rid):
        p.append(f"{filename}: bad id {rid!r}")
    if filename is not None and filename != f"{rid}.json":
        p.append(f"{filename}: file must be named {rid}.json")
    if "available" in recipe and not isinstance(recipe["available"], bool):
        p.append(f"{w}.available must be a boolean")
    if rid == "jarvis-workspace" and recipe.get("available") is not False:
        p.append(f"{w}.available must be false until large-file hosting exists (contracts §6 #15)")
    p += text_problems(f"{w}.title", recipe["title"], TITLE_MAX)
    p += text_problems(f"{w}.description", recipe["description"], DESC_MAX)
    req = recipe["requires"]
    if not isinstance(req, dict) or "os" not in req or not set(req) <= {"os", "minRamGB"}:
        p.append(f"{w}.requires must be {{os, minRamGB?}}")
    else:
        if req["os"] != "rafiq":
            p.append(f'{w}.requires.os must be "rafiq"')
        ram = req.get("minRamGB", 1)
        if not isinstance(ram, int) or isinstance(ram, bool) or not 1 <= ram <= 512:
            p.append(f"{w}.requires.minRamGB must be an integer 1-512")
    steps = recipe["steps"]
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        return p + [f"{w}.steps must hold 1-{MAX_STEPS} steps"]
    seen: set[tuple[str, str]] = set()
    has_note = False
    for i, s in enumerate(steps):
        sw = f"{w}.steps[{i}]"
        if not isinstance(s, dict) or set(s) != STEP:
            p.append(f"{sw} must be exactly {sorted(STEP)}")
            continue
        p += text_problems(f"{sw}.title", s["title"], TITLE_MAX)
        is_note = s["tool"] == NOTE
        check = note if is_note else (RECIPE_TOOLS.get(s["tool"]) if isinstance(s["tool"], str) else None)
        if check is None:
            p.append(f"{sw}: tool {s['tool']!r} is not allowed in recipes (allowed: {sorted(RECIPE_TOOLS)} and {NOTE})")
            continue
        if is_note:
            has_note = True
        elif has_note:
            p.append(f"{sw}: a note step must come after every executing step")
        problems = check(sw, s["input"])
        p += problems
        if s["tool"] == "pkg.install" and not problems:
            for it in s["input"]["items"]:
                k = (it["source"], it["id"])
                if k in seen:
                    p.append(f"{sw}: {k[1]} is already installed by an earlier step")
                seen.add(k)
    if all(isinstance(s, dict) and s.get("tool") == NOTE for s in steps):
        p.append(f"{w}.steps needs at least one executing step")
    return p


def load_dir(directory: Path) -> tuple[dict[str, dict], list[str]]:
    found: dict[str, dict] = {}
    problems: list[str] = []
    for path in sorted(directory.glob("*.json")):
        try:
            found[path.stem] = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            problems.append(f"{path.name}: not valid JSON ({e})")
    return found, problems


def validate_dir(directory: Path = RECIPES) -> list[str]:
    found, problems = load_dir(directory)
    for stem, recipe in found.items():
        problems += validate(recipe, f"{stem}.json")
    for rid in (*SEED, *EXTRA):
        if rid not in found:
            problems.append(f"{rid}.json: required recipe missing (M4 contracts §4, §5)")
    return problems


def sources(directory: Path = RECIPES) -> list[tuple[str, str]]:
    found, _ = load_dir(directory)
    out = {(it["source"], it["id"]) for r in found.values() for s in r.get("steps", [])
           if s.get("tool") == "pkg.install" for it in s["input"]["items"]}
    return sorted(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=("validate", "sources"))
    ap.add_argument("dir", nargs="?", type=Path, default=RECIPES)
    a = ap.parse_args(argv)
    if a.cmd == "sources":
        for source, pid in sources(a.dir):
            print(source, pid)
        return 0
    problems = validate_dir(a.dir)
    for line in problems:
        print(f"recipes: {line}", file=sys.stderr)
    if problems:
        return 1
    print(f"recipes: ok ({len(list(a.dir.glob('*.json')))} recipes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
