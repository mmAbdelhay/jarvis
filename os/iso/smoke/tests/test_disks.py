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
