#!/usr/bin/env python3
"""Every package a recipe installs exists where the recipe says (CI, network).
APT packages are looked up with apt-cache, so run this inside debian:trixie
after apt-get update; Flatpak apps on Flathub's API. Our own jarvis-*
packages come from the Jarvis APT repository and are skipped."""
from __future__ import annotations

import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recipes  # noqa: E402


def apt_exists(pkg: str) -> bool:
    return subprocess.run(["apt-cache", "show", "--no-all-versions", pkg],
                          capture_output=True).returncode == 0


def flathub_exists(app_id: str, opener=urllib.request.urlopen) -> bool:
    req = urllib.request.Request(f"https://flathub.org/api/v2/appstream/{app_id}",
                                 headers={"User-Agent": "jarvis-build/1"})
    try:
        with opener(req, timeout=30) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def main() -> int:
    missing = []
    for source, pid in recipes.sources():
        if source == "apt":
            if pid in recipes.OWN_PACKAGES:
                continue
            if not apt_exists(pid):
                missing.append(f"apt {pid}: not in this system's APT lists (Debian trixie expected)")
        elif not flathub_exists(pid):
            missing.append(f"flatpak {pid}: not on Flathub")
    for line in missing:
        print(f"check_sources: {line}", file=sys.stderr)
    if missing:
        return 1
    print("check_sources: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
