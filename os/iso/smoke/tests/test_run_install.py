import tempfile
import unittest
from pathlib import Path

import run_install
from jarvis_smoke import disks, scenarios


class RunInstallTest(unittest.TestCase):
    def test_brand_is_read_from_brand_env(self):
        b = run_install.brand(run_install.BRAND_ENV)
        self.assertEqual(b["DISTRO_ID"], "rafiq")
        self.assertEqual(b["PRETTY_NAME"], "Rafiq 0.2 (trixie)")

    def test_target_checks_cover_the_criteria(self):
        names = " ".join(n for n, _ in run_install.target_checks(run_install.brand(run_install.BRAND_ENV)))
        for needle in ("Secure Boot", "os-release", "LUKS", "greeter", "127.0.0.1", "live-only", "secrets"):
            self.assertIn(needle, names)
        cmds = dict(run_install.target_checks(run_install.brand(run_install.BRAND_ENV)))
        self.assertTrue(all("\n" not in c for c in cmds.values()), "serial shell takes one line per command")

    def test_scenarios_cover_keyboard_dirty_and_local_model(self):
        self.assertEqual(set(run_install.SCENARIOS), {"erase", "alongside", "refusals", "local-model"})
        names = " ".join(n for n, _ in run_install.keyboard_checks("de"))
        for needle in ("/etc/default/keyboard", "greeter", "labwc"):
            self.assertIn(needle, names)
        cmds = dict(run_install.keyboard_checks("de"))
        self.assertTrue(all("\n" not in c and "de" in c for c in cmds.values()))
        self.assertEqual(run_install.ERASE_KEYBOARD, "de", "the erase install types its secrets on a non-US layout")
        names = " ".join(n for n, _ in run_install.model_checks(run_install.flow.USER))
        for needle in ("criterion 7", "model-state", "ollama", "jarvis.yaml"):
            self.assertIn(needle, names)

    def test_boot_checks_cover_the_separate_boot(self):
        cmds = dict(run_install.boot_checks())
        joined = " ".join(cmds.values())
        for needle in ("Rafiq boot", "/etc/fstab", "/etc/crypttab", "lsinitramfs", "/dev/mapper/"):
            self.assertIn(needle, joined)
        self.assertTrue(all("\n" not in c for c in cmds.values()), "serial shell takes one line per command")

    def test_refusals_cover_every_windows_state(self):
        self.assertEqual(run_install.REFUSALS, {"hibernated": "ntfs-hibernated", "bitlocker": "ntfs-bitlocker", "dirty": "ntfs-dirty"})

    def test_shrink_rules(self):
        gib = 1 << 30
        before = disks.Part(3, 640000, (60 * gib) // 512, "ntfs", "Basic data partition")
        good = disks.Part(3, 640000, (36 * gib) // 512, "ntfs", "Basic data partition")
        moved = disks.Part(3, 700000, (36 * gib) // 512, "ntfs", "Basic data partition")
        not_shrunk = disks.Part(3, 640000, (59 * gib) // 512, "ntfs", "Basic data partition")
        self.assertTrue(run_install.shrunk_ok(before, good, 24 * gib))
        self.assertFalse(run_install.shrunk_ok(before, moved, 24 * gib), "the Windows start never moves (§14)")
        self.assertFalse(run_install.shrunk_ok(before, not_shrunk, 24 * gib))

    def test_refuses_tcg_without_flag(self):
        with tempfile.TemporaryDirectory() as d:
            iso = Path(d) / "x.iso"; iso.write_bytes(b"")
            code = run_install.main(["--iso", str(iso), "--out", d, "--scenario", "erase", "--accel", "tcg"])
            self.assertEqual(code, 2)


class ScenarioUserTest(unittest.TestCase):
    def test_as_user_for_the_installed_user(self):
        line = scenarios.as_user(1000, "true", user="tester")
        self.assertIn("runuser -u tester", line)
        self.assertIn("HOME=/home/tester", line)
        self.assertIn("runuser -u jarvis", scenarios.as_user(1000, "true"))
