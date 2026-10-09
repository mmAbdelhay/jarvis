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

    def test_keyboard_and_local_brain_are_choices(self):
        c = flow.choices("/dev/vda", "erase", keyboard="de", brain=flow.local_brain())
        self.assertEqual(c["keyboard"], "de")
        self.assertEqual(c["brain"], {"kind": "local", "modelId": flow.LOCAL_MODEL_ID})
        self.assertEqual(flow.LOCAL_MODEL_TAG, "llama3.2:3b", "the smallest catalog model")

    def test_secrets_type_on_both_test_layouts(self):
        from jarvis_smoke import qmp
        for layout in ("us", "de"):
            for secret in (flow.PASSWORD, flow.PASSPHRASE, flow.WRONG_PASSPHRASE, flow.WRONG_PASSWORD):
                qmp.text_to_keys(secret, layout=layout)

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
