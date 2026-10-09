import base64
import configparser
import unittest

from jarvis_smoke import credentials


class CredentialsTest(unittest.TestCase):
    def decoded(self):
        out = {}
        args = credentials.smbios_args()
        self.assertEqual(args[0::2], ["-smbios"] * (len(args) // 2))
        for value in args[1::2]:
            self.assertTrue(value.startswith("type=11,value=io.systemd.credential.binary:"))
            self.assertNotIn(",", value[len("type=11,value="):], "a comma would split QEMU's option")
            name, b64 = value.split(":", 1)[1].split("=", 1)
            out[name] = base64.b64decode(b64).decode()
        return out

    def test_unit_and_dropin(self):
        creds = self.decoded()
        self.assertEqual(set(creds), {"systemd.extra-unit.jarvis-test-shell.service",
                                      "systemd.unit-dropin.sysinit.target~jarvis-test-shell"})
        unit = configparser.ConfigParser(strict=False, interpolation=None)
        unit.optionxform = str
        unit.read_string(creds["systemd.extra-unit.jarvis-test-shell.service"])
        self.assertEqual(unit["Service"]["TTYPath"], "/dev/ttyS0")
        self.assertEqual(unit["Service"]["ExecStart"], "/bin/sh")
        self.assertEqual(unit["Unit"]["ConditionVirtualization"], "vm")
        self.assertIn("Wants=jarvis-test-shell.service", creds["systemd.unit-dropin.sysinit.target~jarvis-test-shell"])
