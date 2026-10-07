import unittest

from jarvis_smoke import ram, report

MEMINFO = """MemTotal:        4028000 kB
MemFree:         3000000 kB
MemAvailable:    3516000 kB
Buffers:           10000 kB
"""


class RamTest(unittest.TestCase):
    def test_used_is_total_minus_available(self):
        self.assertEqual(ram.used_mb(MEMINFO), 500.0)

    def test_missing_fields(self):
        with self.assertRaises(ValueError):
            ram.used_mb("MemTotal: 1 kB\n")

    def test_verdicts(self):
        self.assertEqual(ram.verdict(600, 600, 900), "ok")
        self.assertEqual(ram.verdict(601, 600, 900), "warn")
        self.assertEqual(ram.verdict(901, 600, 900), "fail")


class ReportTest(unittest.TestCase):
    def test_summary_table_and_ram_line(self):
        text = report.render_summary(
            [
                {"name": "boot", "ok": True, "seconds": 41.2, "detail": ""},
                {"name": "§11.1 hello", "ok": False, "seconds": 3.0, "detail": "exit 1"},
            ],
            {"used_mb": 512, "verdict": "ok", "warn_mb": 600, "fail_mb": 900},
            "kvm",
        )
        self.assertIn("## Jarvis OS smoke tests (kvm)", text)
        self.assertIn("| boot | PASS | 41.2 s |", text)
        self.assertIn("| §11.1 hello | FAIL | 3.0 s |", text)
        self.assertIn("Idle RAM: **512 MB** (target ≤ 600 MB, ceiling 900 MB): ok", text)

    def test_summary_without_ram(self):
        self.assertIn("Idle RAM: not measured", report.render_summary([], None, "tcg"))


if __name__ == "__main__":
    unittest.main()
