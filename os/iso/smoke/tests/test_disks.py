import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from jarvis_smoke import disks


class DisksTest(unittest.TestCase):
    def test_sparse_digest_sees_data_and_offsets(self):
        with tempfile.TemporaryDirectory() as d:
            a = disks.make_blank(Path(d) / "a.img", 1)
            first = disks.sparse_digest(a)
            with open(a, "r+b") as f:
                f.seek(512 * 1024 * 1024); f.write(b"x")
            second = disks.sparse_digest(a)
            self.assertNotEqual(first, second)
            b = disks.make_blank(Path(d) / "b.img", 1)
            with open(b, "r+b") as f:
                f.seek(512 * 1024 * 1024 + 4096); f.write(b"x")
            self.assertNotEqual(second, disks.sparse_digest(b), "same bytes at another offset differ")

    @unittest.skipUnless(shutil.which("sfdisk"), "sfdisk (util-linux) not installed")
    def test_partitions_parses_sfdisk(self):
        with tempfile.TemporaryDirectory() as d:
            img = disks.make_blank(Path(d) / "p.img", 1)
            subprocess.run(["sfdisk", "-q", str(img)], input="label: gpt\n,100MiB,U\n,,L\n", text=True, check=True)
            parts = disks.partitions(img)
            self.assertEqual([p.number for p in parts], [1, 2])
            self.assertEqual(parts[0].size, 100 * 2048)

    @unittest.skipUnless(os.geteuid() == 0 and shutil.which("mkntfs") and shutil.which("sgdisk"),
                         "needs root, ntfs-3g and gdisk (CI install-test job)")
    def test_windows_disk_states(self):
        with tempfile.TemporaryDirectory() as d:
            img = disks.make_windows_disk(Path(d) / "w.img", 8, "clean")
            parts = disks.partitions(img)
            self.assertEqual(len(parts), 3)
            self.assertEqual(disks.inspect_windows(img), {"ntfsfix": "ok", "bootmgfw": "yes"})
            bl = disks.make_windows_disk(Path(d) / "b.img", 8, "bitlocker")
            with open(bl, "rb") as f:
                f.seek(parts[2].start * 512 + 3)
                self.assertEqual(f.read(8), b"-FVE-FS-")


class NtfsDirtyTest(unittest.TestCase):
    """Criterion 4's ntfs-dirty refusal: the tool must make ntfsresize see a
    volume scheduled for check, with $MFT and $MFTMirr still consistent."""

    @unittest.skipUnless(shutil.which("mkntfs") and shutil.which("ntfsresize") and shutil.which("ntfsfix"),
                         "needs ntfs-3g (CI os checks job)")
    def test_set_dirty_makes_ntfsresize_refuse(self):
        tool = disks.TOOLS / "ntfs-set-dirty.py"
        with tempfile.TemporaryDirectory() as d:
            img = Path(d) / "n.img"
            img.write_bytes(b"")
            os.truncate(img, 256 << 20)
            subprocess.run(["mkntfs", "-F", "-Q", "-q", str(img)], check=True, capture_output=True)
            clean = subprocess.run(["ntfsresize", "--info", "--no-progress-bar", str(img)], capture_output=True, text=True)
            self.assertNotIn("scheduled for check", clean.stdout + clean.stderr)
            subprocess.run(["python3", str(tool), str(img)], check=True)
            dirty = subprocess.run(["ntfsresize", "--info", "--no-progress-bar", str(img)], capture_output=True, text=True)
            self.assertIn("scheduled for check", dirty.stdout + dirty.stderr)
            fix = subprocess.run(["ntfsfix", "--no-action", str(img)], capture_output=True, text=True)
            self.assertIn("$MFT and $MFTMirr completed successfully", fix.stdout)

    def test_set_dirty_refuses_a_non_ntfs_image(self):
        tool = disks.TOOLS / "ntfs-set-dirty.py"
        with tempfile.TemporaryDirectory() as d:
            img = Path(d) / "z.img"
            img.write_bytes(bytes(4096))
            r = subprocess.run(["python3", str(tool), str(img)], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no NTFS boot sector", r.stderr)
