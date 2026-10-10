import json
import unittest
from pathlib import Path

from jarvis_smoke import scenarios
from jarvis_smoke.serial_shell import MAX_LINE

SCRIPTS = Path(__file__).resolve().parents[1] / "assets" / "scripts"
CONTRACT_TOOLS = {
    "pkg.search", "pkg.info", "pkg.list_installed", "disk.usage", "pkg.install", "pkg.remove",
    "sys.health", "logs.query", "svc.status", "svc.list_failed", "net.status", "net.wifi_scan",
    "hw.info", "svc.restart", "net.connection_up", "net.wifi_connect", "net.radio_on",
    "updates.list", "updates.apply",
}


class CommandsTest(unittest.TestCase):
    def all_commands(self):
        return [
            scenarios.as_user(1000, "true"),
            scenarios.jarvisctl(1000, "wait --timeout 90"),
            scenarios.use_fake_provider(1000, "install-hello.json"),
            scenarios.use_fake_provider(1000, None),
            scenarios.connectivity_setup(8099),
            scenarios.wait_connectivity_full(90),
            scenarios.wait_for_user(150),
            scenarios.wait_for_session(150),
            scenarios.wait_for_socket(60),
            scenarios.mount_assets(),
            scenarios.DPKG_HELLO_INSTALLED,
            scenarios.polkit_grants(1000, "os.jarvis.helper.packages"),
            scenarios.HELPER_WAS_ACTIVATED,
            scenarios.APT_HISTORY_HELLO,
            scenarios.DOCTOR_RESTARTED_NM,
            scenarios.shell_relaunches(20),
        ]

    def test_every_command_fits_one_tty_line(self):
        for command in self.all_commands():
            self.assertNotIn("\n", command)
            self.assertLess(len(command), MAX_LINE - 100, command)

    def test_user_commands_reach_the_user_manager(self):
        command = scenarios.as_user(1000, "systemctl --user is-active jarvisd")
        self.assertIn("runuser -u jarvis --", command)
        self.assertIn("XDG_RUNTIME_DIR=/run/user/1000", command)
        self.assertIn("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", command)

    def test_fake_provider_is_set_and_cleared_at_runtime_only(self):
        on = scenarios.use_fake_provider(1000, "net-restart.json")
        self.assertIn("systemctl --user set-environment JARVIS_FAKE_PROVIDER=/run/jarvis-smoke/scripts/net-restart.json", on)
        self.assertIn("systemctl --user restart jarvisd.service", on)
        off = scenarios.use_fake_provider(1000, None)
        self.assertIn("systemctl --user unset-environment JARVIS_FAKE_PROVIDER", off)

    def test_helper_proof_checks_jarvisd_as_the_subject(self):
        command = scenarios.polkit_grants(1000, "os.jarvis.helper.services")
        self.assertIn("systemctl --user show -p MainPID --value jarvisd.service", command)
        self.assertIn("pkcheck --action-id os.jarvis.helper.services --process", command)
        self.assertIn("jarvis-admins", scenarios.REQUIRED_GROUPS)

    def test_connectivity_points_at_the_host(self):
        self.assertIn("uri=http://10.0.2.2:8099/nm", scenarios.connectivity_setup(8099))
        self.assertIn("/etc/NetworkManager/conf.d/99-smoke-connectivity.conf", scenarios.connectivity_setup(8099))


class FakeProviderScriptsTest(unittest.TestCase):
    """Scripts follow contracts §5 and only call contract tools."""

    def test_scripts(self):
        files = sorted(SCRIPTS.glob("*.json"))
        self.assertEqual([f.name for f in files], ["install-hello.json", "net-restart.json", "update-computer.json"])
        for file in files:
            turns = json.loads(file.read_text())
            self.assertIsInstance(turns, list, file)
            for turn in turns:
                self.assertLessEqual(set(turn), {"expectPromptContains", "replies"}, file)
                for reply in turn["replies"]:
                    self.assertEqual(len(set(reply) & {"text", "toolCalls"}), 1, (file, reply))
                    for call in reply.get("toolCalls", []):
                        self.assertEqual(set(call), {"name", "input"}, (file, call))
                        self.assertIn(call["name"], CONTRACT_TOOLS, (file, call))

    def test_hello_installs_from_apt(self):
        turns = json.loads((SCRIPTS / "install-hello.json").read_text())
        calls = [c for r in turns[0]["replies"] for c in r.get("toolCalls", [])]
        self.assertIn({"name": "pkg.install", "input": {"items": [{"source": "apt", "id": "hello"}]}}, calls)

    def test_user_parameter_threads_through(self):
        from jarvis_smoke import scenarios as sc

        self.assertIn("runuser -u tester", sc.jarvisctl(1000, "wait", user="tester"))
        line = sc.use_fake_provider(1000, "x.json", user="tester")
        self.assertNotIn("runuser -u jarvis ", line)
        self.assertIn("runuser -u jarvis", sc.jarvisctl(1000, "wait"))


class JarvisAptTest(unittest.TestCase):
    def test_disable_moves_the_source_aside_in_the_overlay(self):
        from jarvis_smoke import scenarios
        self.assertEqual(
            scenarios.DISABLE_JARVIS_APT,
            "mv /etc/apt/sources.list.d/jarvis.sources /run/jarvis.sources.disabled",
        )


class M3CommandsTest(unittest.TestCase):
    def commands(self):
        return [
            scenarios.user_env_has(1000, "WAYLAND_DISPLAY"),
            scenarios.process_runs("mako"),
            scenarios.polkit_denies(1000, "os.jarvis.helper.admin"),
            scenarios.SETTINGS_RULE_LACKS_ADMIN,
            scenarios.start_lock(1000),
            scenarios.NO_IDLE_ON_LIVE,
            scenarios.VOICE_INSTALLED,
            scenarios.NO_LAN_LISTENER,
            scenarios.LIVE_PASSWORD_SET,
        ]

    def test_every_m3_command_fits_one_tty_line(self):
        for command in self.commands():
            self.assertNotIn("\n", command)
            self.assertLess(len(command), MAX_LINE - 100, command)

    def test_settings_actions_match_the_packaged_rule(self):
        rule = (Path(__file__).resolve().parents[3] / "packaging/jarvis-settings/51-jarvis-settings.rules").read_text()
        for action in scenarios.SETTINGS_ACTIONS:
            self.assertIn(f'"{action}"', rule)

    def test_bluetooth_group_is_required(self):
        self.assertIn("bluetooth", scenarios.REQUIRED_GROUPS)

    def test_lock_runs_as_the_user_on_the_session_display(self):
        command = scenarios.start_lock(1000)
        self.assertIn("runuser -u jarvis --", command)
        self.assertIn("WAYLAND_DISPLAY=", command)
        self.assertIn("jarvis-lock", command)

    def test_polkit_denies_inverts_pkcheck(self):
        self.assertTrue(scenarios.polkit_denies(1000, "x").startswith("pid="))
        self.assertIn("! pkcheck --action-id x", scenarios.polkit_denies(1000, "x"))



class V11FixScenarioTests(unittest.TestCase):
    def test_commands_fit_one_tty_line(self):
        for command in (
            scenarios.keyring_roundtrip(1000),
            scenarios.login_keyring_encrypted("ada"),
        ):
            self.assertNotIn("\n", command)
            self.assertLess(len(command), MAX_LINE - 100, command)

    def test_keyring_roundtrip_is_bounded_and_as_the_user(self):
        command = scenarios.keyring_roundtrip(1001, "ada")
        self.assertIn("runuser -u ada --", command)
        self.assertEqual(command.count("timeout 15 secret-tool"), 3)
        self.assertIn("gcr-prompter", command)


if __name__ == "__main__":
    unittest.main()
