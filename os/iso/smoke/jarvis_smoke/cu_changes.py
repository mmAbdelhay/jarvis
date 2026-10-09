#!/usr/bin/env python3
"""Does a change need the computer-use GUI tests (os.yml jobs cu-test and
cu-kvm-test)? They install GIMP and boot the ISO under KVM, so pull requests
run them only when something on the computer-use path changed; pushes and
manual runs always do (the workflow decides that, not this script).

  cu_changes.py --base REF     prints true or false for `git diff REF...HEAD`
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from collections.abc import Iterable

PREFIXES = (
    "os/go/cmd/jarvis-cu/", "os/go/internal/cu/", "os/go/go.mod", "os/go/go.sum",
    "os/packaging/jarvis-cu/", "os/packaging/jarvis-session/", "os/packaging/jarvisd/",
    "os/iso/cu/", "os/iso/smoke/", "os/iso/config/includes.chroot_after_packages/etc/xdg/",
    "os/iso/config/package-lists/",
    "os/shell/", "os/ui/", "os/lock/",
    "packages/core/", "packages/platform/", "packages/wire/", "packages/desktop/src/daemon/",
    "os/models/catalog.json", ".github/workflows/os.yml",
)


def wants_cu(paths: Iterable[str]) -> bool:
    return any(p.startswith(PREFIXES) for p in paths if p)


def changed(base: str) -> list[str]:
    out = subprocess.run(["git", "diff", "--name-only", f"{base}...HEAD"], check=True, capture_output=True, text=True)
    return out.stdout.splitlines()


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", required=True)
    a = p.parse_args(argv)
    print("true" if wants_cu(changed(a.base)) else "false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
