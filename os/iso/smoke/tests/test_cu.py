import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from jarvis_smoke import cu, qemu
from jarvis_smoke.qmp import Qmp

ASSETS = Path(__file__).resolve().parents[1] / "assets" / "cu"


class CommandsTest(unittest.TestCase):
    def test_every_guest_command_is_one_line(self):
        commands = [
            cu.prepare_logs(), cu.helper_active(1000), cu.socket_private(1000), cu.peer_probe(1000),
            cu.peer_probe(1000, jarvisd_argv=True), cu.INSTALL_GIMP, cu.start_fakevision(1000),
            cu.use_scripted_provider(1000), cu.make_fixture(1000), cu.start_gimp(1000),
            cu.turn(1000, "export", "open the GIMP image beach.xcf and export it as PNG to Pictures", f"--absent {cu.PNG_TARGET}"),
            cu.turn(1000, "lock", "cu-lock: hold the session", background=True), cu.enable(1000), cu.stop(1000),
            cu.wait_check(1000, f"active {cu.log('lock')}", 60), cu.AUDIT_HAS_GOAL, cu.AUDIT_HAS_ACTIONS, cu.AUDIT_HAS_GOAL_AND_ACTIONS,
            cu.no_screenshots_stored(1000),
        ]
        for command in commands:
            self.assertNotIn("\n", command)

    def test_no_screenshots_stored_covers_logs_and_tmp(self):
        command = cu.no_screenshots_stored(1000)
        for where in ("journalctl --user -u jarvisd -u jarvis-cu", " /tmp ", cu.LOGS, "iVBORw0KGgo"):
            self.assertIn(where, command)

    def test_turn_text_cannot_break_quoting(self):
        with self.assertRaises(ValueError):
            cu.turn(1000, "x", "it's")

    def test_background_turns_detach(self):
        self.assertTrue(cu.turn(1000, "lock", "cu-lock: hold", background=True).startswith("setsid -f "))

    def test_assets_match_the_runner(self):
        script = json.loads((ASSETS / "cu-gimp.json").read_text())
        names = {t["name"] for t in script["turns"]}
        self.assertTrue({"off", "export", "physical", "lock"} <= names)
        export = next(t for t in script["turns"] if t["name"] == "export")
        for turn in script["turns"]:
            for step in turn["steps"] + turn.get("onDenied", []):
                self.assertTrue("text" in step or step["call"].startswith("screen_"), step)
        yaml_text = (ASSETS / "jarvis.yaml").read_text()
        self.assertIn("id: scripted, kind: ollama", yaml_text)
        self.assertIn(f"http://127.0.0.1:{cu.PORT}", yaml_text)


    # Gap G7: the click that writes the PNG declares intent save; the Export
    # Image dialog's Export click declares nothing, so its card proves the
    # label/AT-SPI detection (consequential.ts).
    def test_export_clicks_with_save_intent(self):
        script = json.loads((ASSETS / "cu-gimp.json").read_text())
        export = next(t for t in script["turns"] if t["name"] == "export")
        clicks = [s for s in export["steps"] if s.get("call") == "screen_click" and s["input"]["target"] == "Export"]
        self.assertEqual(len(clicks), 2)
        self.assertNotIn("intent", clicks[0]["input"])
        self.assertEqual(clicks[1]["input"].get("intent"), "save", "the export clicks with intent save (gap G7)")


class PpmTest(unittest.TestCase):
    def ppm(self, w, h, color, frame=None, band=4):
        px = bytearray()
        for y in range(h):
            for x in range(w):
                edge = y < band or y >= h - band or x < band or x >= w - band
                px += bytes(frame if edge and frame else color)
        path = Path(tempfile.mkdtemp()) / "s.ppm"
        path.write_bytes(f"P6\n{w} {h}\n255\n".encode() + bytes(px))
        return path

    def test_teal_frame_ratio(self):
        teal = (20, 184, 166)
        self.assertGreaterEqual(cu.frame_teal_ratio(*cu.read_ppm(self.ppm(40, 30, (30, 30, 30), teal))), 0.99)
        self.assertEqual(cu.frame_teal_ratio(*cu.read_ppm(self.ppm(40, 30, (30, 30, 30)))), 0.0)

    def test_rejects_other_formats(self):
        path = Path(tempfile.mkdtemp()) / "x.ppm"
        path.write_bytes(b"P3\n1 1\n255\n0 0 0\n")
        with self.assertRaises(ValueError):
            cu.read_ppm(path)


class QemuAndQmpTest(unittest.TestCase):
    def test_extra_devices_reach_the_command_line(self):
        cfg = qemu.VmConfig(iso=Path("a.iso"), assets=Path("b.iso"), kernel=Path("k"), initrd=Path("i"), append="x",
                            serial_socket=Path("s"), qmp_socket=Path("q"), accel="kvm", extra=("-device", "usb-tablet"))
        argv = qemu.qemu_argv(cfg)
        self.assertIn("usb-tablet", argv)
        self.assertEqual(argv[-1], "-no-reboot")

    def test_move_pointer_abs_sends_two_abs_events(self):
        a, b = socket.socketpair()
        seen = []

        def server():
            f = b.makefile("rwb")
            seen.append(json.loads(f.readline()))
            f.write(b'{"return": {}}\n')
            f.flush()

        t = threading.Thread(target=server)
        t.start()
        Qmp(a).move_pointer_abs(100, 200)
        t.join(5)
        self.assertEqual(seen[0], {"execute": "input-send-event", "arguments": {"events": [
            {"type": "abs", "data": {"axis": "x", "value": 100}},
            {"type": "abs", "data": {"axis": "y", "value": 200}}]}})


if __name__ == "__main__":
    unittest.main()


class BlockedTest(unittest.TestCase):
    def test_blocked_is_flagged_and_fails_only_when_asked(self):
        from jarvis_smoke import report
        results = [{"name": "a", "ok": True, "seconds": 1.0, "detail": ""}, report.blocked("b", "U-1")]
        self.assertEqual(report.exit_code(results, False), 0)
        self.assertEqual(report.exit_code(results, True), 1)
        self.assertEqual(report.exit_code([{"name": "a", "ok": False, "seconds": 1.0, "detail": "x"}], False), 1)
        self.assertEqual(report.exit_code([], False), 1)
        summary = report.render_summary(results, None, "kvm")
        self.assertIn("| b | BLOCKED |", summary)
        self.assertIn("NOT verified", summary)
