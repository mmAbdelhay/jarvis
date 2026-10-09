#!/usr/bin/env python3
"""Fail if an H-owned file hard-codes the distro name (contracts §9). The name
lives only in os/branding/brand.env; everything else renders @DISTRO_NAME@ or
reads $DISTRO_NAME. Flags the current DISTRO_NAME/DISTRO_NAME_AR/DISTRO_ID (read from
brand.env) and the retired "Jarvis OS" in any spelling. Comments, Markdown,
tests (which pin the contract values on purpose) and references to
docs/superpowers/… files are allowed."""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

LEGACY = r"jarvis[ _-]?os(?![a-z])"
BRAND_ENV = Path(__file__).resolve().parents[1] / "brand.env"
DOC_REF = re.compile(r"docs/superpowers/\S+")
COMMENT = re.compile(r"^\s*(#|//|<!--|\*|;|\")")
ROOTS = ("os/iso", "os/packaging", "os/branding", "os/models", "os/repo")
ALLOWED = {"os/branding/brand.env", "os/branding/tools/name-lint.py"}
ALLOWED_PREFIXES = ("os/branding/tests/fixtures/",)
# Tests deliberately pin the contracts §9 values; shipped files must not.
TEST_DIRS = re.compile(r"(^|/)tests?/")


def candidate_files(root: Path) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--", *ROOTS, ".github/workflows"],
            check=True, capture_output=True, text=True,
        ).stdout.split()
        if out:
            return out
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    files = []
    for top in (*ROOTS, ".github/workflows"):
        base = root / top
        if base.is_dir():
            files += [str(p.relative_to(root)) for p in base.rglob("*") if p.is_file()]
    return files


def wanted(rel: str) -> bool:
    if rel.startswith(".github/workflows/"):
        return Path(rel).name.startswith("os")
    if rel in ALLOWED or rel.endswith(".md") or rel.startswith(ALLOWED_PREFIXES) or TEST_DIRS.search(rel):
        return False
    return rel.startswith(ROOTS)


def brand_pattern(brand_env: Path = BRAND_ENV) -> re.Pattern[str]:
    values = dict(re.findall(r'^(DISTRO_NAME|DISTRO_NAME_AR|DISTRO_ID)="([^"]+)"$', brand_env.read_text(), re.M))
    words = [re.escape(values[k]) for k in ("DISTRO_NAME", "DISTRO_NAME_AR", "DISTRO_ID") if k in values]
    current = rf"(?<![A-Za-z0-9])({'|'.join(words)})(?![A-Za-z0-9])" if words else None
    return re.compile(LEGACY + (f"|{current}" if current else ""), re.IGNORECASE)


def violations(root: Path) -> list[str]:
    pattern = brand_pattern()
    found = []
    for rel in sorted(filter(wanted, candidate_files(root))):
        data = (root / rel).read_bytes()
        if b"\0" in data:
            continue
        for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if COMMENT.match(line):
                continue
            if pattern.search(DOC_REF.sub("", line)):
                found.append(f"{rel}:{number}: {line.strip()}")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    found = violations(parser.parse_args().root)
    for line in found:
        print(line)
    if found:
        print("name-lint: use @DISTRO_NAME@ / $DISTRO_NAME from os/branding/brand.env", file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
