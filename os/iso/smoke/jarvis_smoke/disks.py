"""Host-side disk images for the install tests (design §13)."""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"


@dataclass(frozen=True)
class Part:
    number: int
    start: int  # 512-byte sectors
    size: int
    type: str
    name: str


def _root(argv: list[str]) -> list[str]:
    return argv if os.geteuid() == 0 else ["sudo", "-n", *argv]


def make_blank(path: Path, size_gib: int) -> Path:
    with open(path, "wb") as f:
        f.truncate(size_gib << 30)
    return path


def make_windows_disk(path: Path, size_gib: int, state: str) -> Path:
    subprocess.run(_root([str(TOOLS / "make-windows-disk.sh"), str(path), str(size_gib), state]), check=True)
    if os.geteuid() != 0:
        subprocess.run(["sudo", "-n", "chown", f"{os.getuid()}:{os.getgid()}", str(path)], check=True)
    return path


def sparse_digest(path: Path) -> str:
    """sha256 over (offset, bytes) of every data extent: fast on sparse images,
    and any write anywhere changes it (criterion 5)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        fd, size, pos = f.fileno(), os.fstat(f.fileno()).st_size, 0
        while pos < size:
            try:
                start = os.lseek(fd, pos, os.SEEK_DATA)
            except OSError:
                break
            end = os.lseek(fd, start, os.SEEK_HOLE)
            f.seek(start)
            h.update(start.to_bytes(8, "big"))
            remaining = end - start
            while remaining:
                chunk = f.read(min(remaining, 8 << 20))
                if not chunk:
                    break
                h.update(chunk)
                remaining -= len(chunk)
            pos = end
    return h.hexdigest()


def partitions(path: Path) -> list[Part]:
    out = subprocess.run(["sfdisk", "--json", str(path)], check=True, capture_output=True, text=True).stdout
    table = json.loads(out)["partitiontable"]
    parts = []
    for p in table.get("partitions", []):
        number = int(re.search(r"(\d+)$", p["node"]).group(1))  # "w.img3", "/dev/loop0p3"
        parts.append(Part(number, p["start"], p["size"], p.get("type", ""), p.get("name", "")))
    return parts


def inspect_windows(path: Path) -> dict[str, str]:
    out = subprocess.run(_root([str(TOOLS / "inspect-windows-disk.sh"), str(path)]),
                         check=True, capture_output=True, text=True).stdout
    return dict(line.split("=", 1) for line in out.split())
