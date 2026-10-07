import tempfile
import unittest
from pathlib import Path

from jarvis_smoke import qemu


def config(accel):
    p = Path("/tmp/x")
    return qemu.VmConfig(
        iso=p / "a.iso", assets=p / "b.iso", kernel=p / "k", initrd=p / "i",
        append="boot=live", serial_socket=p / "s.sock", qmp_socket=p / "q.sock", accel=accel,
    )


class QemuTest(unittest.TestCase):
    def test_append_adds_the_harness_console(self):
        line = qemu.kernel_append("boot=live components quiet\n")
        self.assertEqual(
            line,
            "boot=live components quiet console=ttyS0,115200n8 systemd.debug_shell=ttyS0 loglevel=3",
        )

    def test_append_refuses_a_release_line_that_already_opens_a_shell(self):
        for bad in ("boot=live systemd.debug_shell", "boot=live console=ttyS0", "JARVIS_X=1"):
            with self.assertRaises(ValueError):
                qemu.kernel_append(bad)

    def test_picks_versioned_kernel_and_initrd(self):
        names = ["filesystem.squashfs", "initrd.img-6.12.48+deb13-amd64", "vmlinuz-6.12.48+deb13-amd64"]
        self.assertEqual(
            qemu.pick_boot_files(names),
            ("vmlinuz-6.12.48+deb13-amd64", "initrd.img-6.12.48+deb13-amd64"),
        )

    def test_prefers_unversioned_names(self):
        names = ["vmlinuz", "vmlinuz-6.1", "initrd.img", "initrd.img-6.1"]
        self.assertEqual(qemu.pick_boot_files(names), ("vmlinuz", "initrd.img"))

    def test_missing_kernel_is_an_error(self):
        with self.assertRaises(FileNotFoundError):
            qemu.pick_boot_files(["filesystem.squashfs"])

    def test_kvm_argv(self):
        argv = qemu.qemu_argv(config("kvm"))
        self.assertIn("kvm", argv)
        self.assertIn("host", argv)
        self.assertIn("unix:/tmp/x/s.sock,server=on,wait=off", argv)
        self.assertIn("file=/tmp/x/b.iso,format=raw,if=virtio,readonly=on", argv)

    def test_tcg_argv(self):
        argv = qemu.qemu_argv(config("tcg"))
        self.assertIn("tcg,thread=multi", argv)
        self.assertNotIn("kvm", argv)

    def test_detect_accel(self):
        self.assertEqual(qemu.detect_accel("/nonexistent/kvm"), "tcg")
        with tempfile.NamedTemporaryFile() as fake:
            self.assertEqual(qemu.detect_accel(fake.name), "kvm")


if __name__ == "__main__":
    unittest.main()
