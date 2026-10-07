import tempfile
import unittest
from pathlib import Path

from jarvis_smoke import firmware, qemu


class FirmwareTest(unittest.TestCase):
    def test_explicit_paths_and_vars_copy(self):
        with tempfile.TemporaryDirectory() as d:
            code, tpl = Path(d) / "code.fd", Path(d) / "vars.fd"
            code.write_bytes(b"c"); tpl.write_bytes(b"v")
            ovmf = firmware.find_ovmf(code, tpl)
            copy = firmware.make_vars(ovmf, Path(d) / "run" / "vars.fd")
            self.assertEqual(copy.read_bytes(), b"v")
            copy.write_bytes(b"changed")
            self.assertEqual(tpl.read_bytes(), b"v", "the template is never written")

    def test_missing_names_the_package(self):
        with self.assertRaisesRegex(FileNotFoundError, "ovmf"):
            firmware.find_ovmf(Path("/nope/c.fd"), Path("/nope/v.fd"))

    def test_install_vm_argv(self):
        p = Path("/w")
        vm = qemu.InstallVm(disks=(p / "t.img",), assets=p / "a.iso", serial_socket=p / "s", qmp_socket=p / "q",
                            ovmf=firmware.Ovmf(p / "c.fd", p / "v.fd"), vars_path=p / "vars.fd", accel="kvm", iso=p / "x.iso")
        argv = qemu.install_qemu_argv(vm)
        joined = " ".join(argv)
        self.assertIn("-machine q35,smm=on", joined)
        self.assertIn("driver=cfi.pflash01,property=secure,value=on", joined)
        self.assertIn(f"if=pflash,format=raw,unit=0,readonly=on,file={p / 'c.fd'}", joined)
        self.assertIn(f"if=pflash,format=raw,unit=1,file={p / 'vars.fd'}", joined)
        self.assertLess(joined.index("t.img"), joined.index("a.iso"), "target disk is vda")
        self.assertIn("media=cdrom", joined)
        self.assertIn("io.systemd.credential.binary:systemd.extra-unit.jarvis-test-shell.service", joined)
        self.assertNotIn("-kernel", argv, "firmware boot, not direct kernel boot")
        no_iso = qemu.install_qemu_argv(qemu.InstallVm(**{**vm.__dict__, "iso": None}))
        self.assertNotIn("media=cdrom", " ".join(no_iso))
