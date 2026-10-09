import tempfile
import unittest
from pathlib import Path

from jarvis_smoke import screen

BG = (0x0D, 0x10, 0x14)


def canvas(w=1280, h=800):
    return [[BG] * w for _ in range(h)]


def draw_entry(px, x, y, bullets=0):
    for j in range(48):
        for i in range(480):
            border = i < 2 or i >= 478 or j < 2 or j >= 46
            px[y + j][x + i] = screen.ENTRY_BORDER if border else screen.ENTRY_FILL
    for b in range(bullets):
        for j in range(4, 8):
            for i in range(4, 8):
                px[y + 18 + j][x + 16 + b * 14 + i] = screen.BULLET


def write_ppm(path, px):
    h, w = len(px), len(px[0])
    with open(path, "wb") as f:
        f.write(f"P6\n# qemu\n{w} {h}\n255\n".encode())
        f.write(bytes(c for row in px for p in row for c in p))


class ScreenTest(unittest.TestCase):
    def roundtrip(self, px):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "s.ppm"
            write_ppm(p, px)
            return screen.read_ppm(p)

    def test_reads_ppm(self):
        px = canvas(4, 2); px[1][3] = (1, 2, 3)
        img = self.roundtrip(px)
        self.assertEqual((img.width, img.height, img.px(3, 1)), (4, 2, (1, 2, 3)))

    def test_finds_prompt_and_counts_bullets(self):
        px = canvas(); draw_entry(px, 400, 500, bullets=5)
        img = self.roundtrip(px)
        box = screen.find_prompt(img)
        self.assertEqual((box.x, box.y, box.w, box.h), (400, 500, 480, 48))
        self.assertEqual(screen.bullet_pixels(img, box), 5 * 16)

    def test_no_prompt_on_splash_or_ring(self):
        px = canvas()
        for i in range(200):  # a short accent run (ring arc) is not the entry
            px[100][300 + i] = screen.ENTRY_BORDER
        self.assertIsNone(screen.find_prompt(self.roundtrip(px)))

    def test_empty_prompt_has_no_bullets(self):
        px = canvas(); draw_entry(px, 0, 0)
        img = self.roundtrip(px)
        self.assertEqual(screen.bullet_pixels(img, screen.find_prompt(img)), 0)
