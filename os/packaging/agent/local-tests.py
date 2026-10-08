#!/usr/bin/env python3
"""Local validation tests; container integration is exercised by install-test.sh."""
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

class InstallArguments(unittest.TestCase):
    def run_install(self, *args):
        return subprocess.run(["bash", str(HERE / "install-test.sh"), *args], capture_output=True, text=True)

    def test_requires_archive_keyring_before_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("jarvis-agent", "jarvisd", "jarvis-pkg", "jarvis-diag", "jarvis-helper", "jarvis-cli"):
                Path(tmp, name + "_0.0.0~stub1_all.deb").touch()
            result = self.run_install("--debs", tmp, "--image", "debian:trixie")
            self.assertEqual(result.returncode, 1)
            self.assertIn("need exactly one jarvis-archive-keyring .deb", result.stderr)

    def test_missing_option_value_is_diagnosed(self):
        result = self.run_install("--debs")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--debs requires a value", result.stderr)

    def test_rejects_unknown_image_and_level(self):
        for args in [("--image", "alpine:latest"), ("--image", "ubuntu:24.04", "--level", "other")]:
            with self.subTest(args=args):
                result = self.run_install(*args)
                self.assertEqual(result.returncode, 1)
                self.assertIn("must be", result.stderr)

    def test_duplicate_debs_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for version in ("1", "2"):
                Path(tmp, "jarvis-agent_" + version + "_all.deb").touch()
            result = self.run_install("--debs", tmp, "--image", "debian:trixie")
            self.assertEqual(result.returncode, 1)
            self.assertIn("need exactly one jarvis-agent .deb", result.stderr)

if __name__ == "__main__":
    unittest.main()
