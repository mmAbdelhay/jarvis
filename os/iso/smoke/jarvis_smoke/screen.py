"""Find the Plymouth disk-unlock prompt on a QMP screendump (PPM).
The theme (os/branding/plymouth) draws entry.png unscaled: 480x48, 2 px
border ENTRY_BORDER, fill ENTRY_FILL; bullets are BULLET pixels inside it."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

ENTRY_BORDER = (0x4F, 0xD8, 0xC4)
ENTRY_FILL = (0x15, 0x1A, 0x20)
BULLET = (0xE7, 0xEA, 0xEE)
ENTRY_W, ENTRY_H = 480, 48


@dataclass(frozen=True)
class Image:
    width: int
    height: int
    data: bytes

    def px(self, x: int, y: int) -> tuple[int, int, int]:
        i = (y * self.width + x) * 3
        return self.data[i], self.data[i + 1], self.data[i + 2]


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int


def read_ppm(path: Path) -> Image:
    raw = Path(path).read_bytes()
    fields: list[bytes] = []
    pos = 0
    while len(fields) < 4:
        while raw[pos:pos + 1].isspace():
            pos += 1
        if raw[pos:pos + 1] == b"#":
            pos = raw.index(b"\n", pos) + 1
            continue
        end = pos
        while not raw[end:end + 1].isspace():
            end += 1
        fields.append(raw[pos:end])
        pos = end
    if fields[0] != b"P6" or fields[3] != b"255":
        raise ValueError(f"{path}: not an 8-bit P6 PPM")
    w, h = int(fields[1]), int(fields[2])
    pos += 1
    return Image(w, h, raw[pos:pos + w * h * 3])


def find_prompt(img: Image) -> Box | None:
    run = bytes(ENTRY_BORDER) * ENTRY_W
    stride = img.width * 3
    for y in range(img.height - ENTRY_H + 1):
        row = img.data[y * stride:(y + 1) * stride]
        start = row.find(run)
        while start != -1:
            if start % 3 == 0:
                x = start // 3
                bottom = (y + ENTRY_H - 1) * stride + start
                if (img.data[bottom:bottom + len(run)] == run
                        and img.px(x + 1, y + ENTRY_H // 2) == ENTRY_BORDER
                        and img.px(x + ENTRY_W // 2, y + 3) != ENTRY_BORDER):
                    return Box(x, y, ENTRY_W, ENTRY_H)
            start = row.find(run, start + 1)
    return None


def bullet_pixels(img: Image, box: Box) -> int:
    count = 0
    for y in range(box.y + 2, box.y + box.h - 2):
        for x in range(box.x + 2, box.x + box.w - 2):
            if img.px(x, y) == BULLET:
                count += 1
    return count
