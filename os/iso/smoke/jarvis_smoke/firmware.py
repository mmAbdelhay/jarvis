"""OVMF with Secure Boot and Microsoft keys enrolled (design §13)."""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

CANDIDATES = (
    ("/usr/share/OVMF/OVMF_CODE_4M.secboot.fd", "/usr/share/OVMF/OVMF_VARS_4M.ms.fd"),
    ("/usr/share/OVMF/OVMF_CODE.secboot.fd", "/usr/share/OVMF/OVMF_VARS.ms.fd"),
)


@dataclass(frozen=True)
class Ovmf:
    code: Path
    vars_template: Path


def find_ovmf(code: Path | None = None, vars_template: Path | None = None) -> Ovmf:
    pairs = [(code, vars_template)] if code and vars_template else [(Path(c), Path(v)) for c, v in CANDIDATES]
    for c, v in pairs:
        if c.is_file() and v.is_file():
            return Ovmf(c, v)
    raise FileNotFoundError(
        "no Secure Boot OVMF (OVMF_CODE*.secboot.fd + OVMF_VARS*.ms.fd): install the ovmf package "
        "or pass --ovmf-code/--ovmf-vars")


def make_vars(ovmf: Ovmf, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ovmf.vars_template, dest)
    return dest
