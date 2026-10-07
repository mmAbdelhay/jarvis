import base64
import json
import unittest

from jarvis_smoke import install_flow as flow


class FlowTest(unittest.TestCase):
    def test_erase_choices_match_contract(self):
        c = flow.choices("/dev/vda", "erase")
        self.assertEqual(set(c), {"locale", "keyboard", "timezone", "disk", "encrypt", "user", "brain"})
        self.assertEqual(c["disk"], {"path": "/dev/vda", "mode": "erase"})
        self.assertTrue(c["encrypt"])
        self.assertEqual(c["user"], {"fullName": "Test User", "username": "tester", "hostname": "testbox", "autologin": False})
        self.assertEqual(c["brain"], {"kind": "cloud"})
        self.assertEqual(c["keyboard"], "us", "QMP types with the US layout")

    def test_alongside_needs_a_size(self):
        self.assertEqual(flow.choices("/dev/vda", "alongside", alongside_bytes=24 << 30)["disk"]["alongsideSizeBytes"], 24 << 30)
        with self.assertRaises(ValueError):
            flow.choices("/dev/vda", "alongside")

    def test_write_json_is_one_line_without_quotes_trouble(self):
        line = flow.write_json("/run/x.json", {"a": "it's \"quoted\" $HOME"})
        self.assertNotIn("\n", line)
        b64 = line.split()[1]
        self.assertEqual(json.loads(base64.b64decode(b64)), {"a": "it's \"quoted\" $HOME"})

    def test_execute_writes_secrets_only_to_run(self):
        line = flow.execute(1800)
        self.assertIn("/run/inst-secrets.json", line)
        self.assertNotIn(flow.PASSPHRASE, line, "secrets travel base64-encoded, never as plain argv text")
        self.assertIn("--timeout 1800", line)
