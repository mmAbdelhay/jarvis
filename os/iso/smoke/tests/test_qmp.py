import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from jarvis_smoke import qmp


class KeysTest(unittest.TestCase):
    def test_letters_digits_and_shift(self):
        self.assertEqual(qmp.text_to_keys("aZ9"), [["a"], ["shift", "z"], ["9"]])

    def test_passphrase_symbols(self):
        self.assertEqual(qmp.text_to_keys("-!\n "), [["minus"], ["shift", "1"], ["ret"], ["spc"]])

    def test_german_layout_moves_the_keys_that_differ(self):
        # Under XKB "de" the keys QEMU names by US position type other
        # characters: y/z swap, "-" sits on the US "/" key (contracts §11.5).
        self.assertEqual(qmp.text_to_keys("zy-42\n", layout="de"), [["y"], ["z"], ["slash"], ["4"], ["2"], ["ret"]])
        self.assertEqual(qmp.text_to_keys("Tester", layout="de"), [["shift", "t"], ["e"], ["s"], ["t"], ["e"], ["r"]])
        with self.assertRaises(ValueError):
            qmp.text_to_keys("@", layout="de")
        with self.assertRaises(ValueError):
            qmp.text_to_keys("a", layout="fr")

    def test_refuses_non_us_characters(self):
        with self.assertRaises(ValueError):
            qmp.text_to_keys("é")


class FakeQmpServer:
    """Answers the greeting, capabilities and any command with {"return": {}}
    (query-status returns running), after first emitting an event."""

    def __init__(self, path: Path):
        self.received: list[dict] = []
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(str(path))
        self._srv.listen(1)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        conn, _ = self._srv.accept()
        f = conn.makefile("rwb")
        f.write(b'{"QMP": {"version": {}, "capabilities": []}}\n'); f.flush()
        for line in f:
            msg = json.loads(line)
            self.received.append(msg)
            f.write(b'{"event": "RTC_CHANGE", "data": {}}\n')
            if msg["execute"] == "query-status":
                f.write(b'{"return": {"status": "running", "running": true}}\n')
            elif msg["execute"] == "bad":
                f.write(b'{"error": {"class": "CommandNotFound", "desc": "nope"}}\n')
            else:
                f.write(b'{"return": {}}\n')
            f.flush()


class QmpClientTest(unittest.TestCase):
    def test_commands_keys_and_errors(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "q.sock"
            server = FakeQmpServer(path)
            client = qmp.Qmp.connect(str(path), timeout=5)
            self.assertEqual(client.status(), "running")
            client.type_text("Ab", delay=0)
            with self.assertRaises(qmp.QmpError):
                client.command("bad")
            client.close()
            sent = [m for m in server.received if m["execute"] == "send-key"]
            self.assertEqual(server.received[0]["execute"], "qmp_capabilities")
            self.assertEqual(sent[0]["arguments"]["keys"], [{"type": "qcode", "data": "shift"}, {"type": "qcode", "data": "a"}])
            self.assertEqual(sent[1]["arguments"]["keys"], [{"type": "qcode", "data": "b"}])
            self.assertTrue(client.events, "events are kept, not mistaken for replies")
