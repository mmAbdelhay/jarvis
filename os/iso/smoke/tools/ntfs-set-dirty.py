#!/usr/bin/env python3
"""ntfs-set-dirty.py DEVICE_OR_IMAGE — sets VOLUME_IS_DIRTY in an NTFS
volume's $Volume record (and its $MFTMirr copy), as Windows does when it
shut down uncleanly or scheduled chkdsk. ntfsresize then refuses with
"Volume is scheduled for check", which the installer maps to the
`ntfs-dirty` refusal (criterion 4). Stdlib only; used by make-windows-disk.sh."""
from __future__ import annotations

import struct
import sys

VOLUME_RECORD = 3          # $Volume
VOLUME_INFORMATION = 0x70  # attribute type
VOLUME_IS_DIRTY = 0x0001
FIXUP_STRIDE = 512


def record_size(boot: bytes) -> tuple[int, int, int]:
    if boot[3:11] != b"NTFS    ":
        raise ValueError("no NTFS boot sector")
    bps = struct.unpack_from("<H", boot, 0x0B)[0]
    cluster = bps * boot[0x0D]
    mft, mirr = struct.unpack_from("<qq", boot, 0x30)
    c = struct.unpack_from("<b", boot, 0x40)[0]
    size = cluster * c if c > 0 else 1 << -c
    return size, mft * cluster, mirr * cluster


def unfix(rec: bytearray) -> list[int]:
    """Undoes the update sequence array in place; returns its offset and count."""
    if rec[0:4] != b"FILE":
        raise ValueError("not an MFT FILE record")
    usa_off, usa_count = struct.unpack_from("<HH", rec, 4)
    usn = rec[usa_off:usa_off + 2]
    for i in range(1, usa_count):
        end = i * FIXUP_STRIDE - 2
        if rec[end:end + 2] != usn:
            raise ValueError("MFT record fails its fixup check")
        rec[end:end + 2] = rec[usa_off + 2 * i:usa_off + 2 * i + 2]
    return [usa_off, usa_count]


def refix(rec: bytearray, usa_off: int, usa_count: int) -> None:
    usn = rec[usa_off:usa_off + 2]
    for i in range(1, usa_count):
        end = i * FIXUP_STRIDE - 2
        rec[usa_off + 2 * i:usa_off + 2 * i + 2] = rec[end:end + 2]
        rec[end:end + 2] = usn


def set_dirty(rec: bytearray) -> None:
    usa_off, usa_count = unfix(rec)
    off = struct.unpack_from("<H", rec, 0x14)[0]
    while off + 8 <= len(rec):
        kind, length = struct.unpack_from("<II", rec, off)
        if kind == 0xFFFFFFFF or length == 0:
            break
        if kind == VOLUME_INFORMATION and rec[off + 8] == 0:
            value = off + struct.unpack_from("<H", rec, off + 0x14)[0]
            flags = struct.unpack_from("<H", rec, value + 10)[0]
            struct.pack_into("<H", rec, value + 10, flags | VOLUME_IS_DIRTY)
            refix(rec, usa_off, usa_count)
            return
        off += length
    raise ValueError("$Volume has no resident VOLUME_INFORMATION")


def main(path: str) -> None:
    with open(path, "r+b") as f:
        size, mft, mirr = record_size(f.read(512))
        for base in (mft, mirr):
            f.seek(base + VOLUME_RECORD * size)
            rec = bytearray(f.read(size))
            set_dirty(rec)
            f.seek(base + VOLUME_RECORD * size)
            f.write(rec)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
