#!/usr/bin/env python3
"""Every package a recipe installs exists where the recipe says (CI, network).
APT packages are looked up with apt-cache, so run this inside debian:trixie
after apt-get update; Flatpak apps on Flathub's API. Our own jarvis-*
packages come from the Jarvis APT repository and are skipped.

The Flathub lookups need the network. When it is unreachable after a few
tries (a transient runner/container outage, or an offline machine) they are
reported as SKIPPED instead of failing the build; JARVIS_REQUIRE_NETWORK=1
turns that back into a failure."""
from __future__ import annotations

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recipes  # noqa: E402


def apt_exists(pkg: str) -> bool:
    return subprocess.run(["apt-cache", "show", "--no-all-versions", pkg],
                          capture_output=True).returncode == 0


class NetworkUnavailable(Exception):
    """Flathub could not be reached at all (not an HTTP answer)."""


def flathub_exists(app_id: str, opener=urllib.request.urlopen, tries: int = 3,
                   sleep=time.sleep) -> bool:
    req = urllib.request.Request(f"https://flathub.org/api/v2/appstream/{app_id}",
                                 headers={"User-Agent": "jarvis-build/1"})
    last: Exception | None = None
    for attempt in range(tries):
        try:
            with opener(req, timeout=30) as resp:
                return resp.status == 200
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False
            raise
        except (urllib.error.URLError, OSError) as e:  # no route, DNS, timeout
            last = e
            if attempt + 1 < tries:
                sleep(2 ** attempt)
    raise NetworkUnavailable(str(last))


def main() -> int:
    missing = []
    offline: str | None = None
    skipped = 0
    for source, pid in recipes.sources():
        if source == "apt":
            if pid in recipes.OWN_PACKAGES:
                continue
            if not apt_exists(pid):
                missing.append(f"apt {pid}: not in this system's APT lists (Debian trixie expected)")
        elif offline is None:
            try:
                if not flathub_exists(pid):
                    missing.append(f"flatpak {pid}: not on Flathub")
            except NetworkUnavailable as e:
                offline = str(e)
        else:
            skipped += 1
    if offline is not None:
        message = f"Flathub unreachable ({offline}); Flatpak sources NOT checked"
        if os.environ.get("JARVIS_REQUIRE_NETWORK") == "1":
            missing.append(message)
        else:
            print(f"check_sources: SKIPPED {message} ({skipped + 1} apps)", file=sys.stderr)
            if os.environ.get("GITHUB_ACTIONS") == "true":
                print(f"::warning title=check_sources::{message}")
    for line in missing:
        print(f"check_sources: {line}", file=sys.stderr)
    if missing:
        return 1
    print("check_sources: ok" + (" (APT only)" if offline is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
