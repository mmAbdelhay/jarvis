import socket
import subprocess
import threading
import unittest

from jarvis_smoke.serial_shell import CommandFailed, SerialShell, SerialTimeout


class FakeGuest(threading.Thread):
    """A serial console in miniature: echoes each line like a tty (CRLF),
    runs it with sh, writes the output with CRLF. Optional boot noise first."""

    def __init__(self, sock, noise=b""):
        super().__init__(daemon=True)
        self.sock = sock
        self.noise = noise

    def run(self):
        if self.noise:
            self.sock.sendall(self.noise)
        stream = self.sock.makefile("rb")
        for raw in stream:
            self.sock.sendall(raw.replace(b"\n", b"\r\n"))
            line = raw.decode().strip()
            if not line:
                continue
            out = subprocess.run(["sh", "-c", line], capture_output=True).stdout
            try:
                self.sock.sendall(out.replace(b"\n", b"\r\n"))
            except OSError:
                return


def shell(noise=b""):
    host, guest = socket.socketpair()
    FakeGuest(guest, noise).start()
    return SerialShell(host)


class SerialShellTest(unittest.TestCase):
    def test_returns_status_and_output(self):
        self.assertEqual(shell().run("echo hello"), (0, "hello\n"))

    def test_failure_status_and_stderr(self):
        self.assertEqual(shell().run("echo oops >&2; false"), (1, "oops\n"))

    def test_exit_does_not_kill_the_console(self):
        s = shell()
        self.assertEqual(s.run("exit 3"), (3, ""))
        self.assertEqual(s.run("echo still here"), (0, "still here\n"))

    def test_echoed_command_line_never_ends_a_command_early(self):
        # The fake guest echoes every line, markers included as typed.
        status, output = shell().run("sleep 0.2; echo late")
        self.assertEqual((status, output), (0, "late\n"))

    def test_run_ok_raises_with_output(self):
        with self.assertRaises(CommandFailed) as caught:
            shell().run_ok("echo boom; exit 4")
        self.assertEqual(caught.exception.status, 4)
        self.assertIn("boom", caught.exception.output)

    def test_wait_for_shell_skips_boot_noise(self):
        s = shell(noise=b"[    1.234] random: crng init done\r\nWelcome\r\n")
        s.wait_for_shell(timeout=10)
        self.assertEqual(s.run("echo ok"), (0, "ok\n"))

    def test_timeout(self):
        with self.assertRaises(SerialTimeout):
            shell().run("sleep 3", timeout=0.3)

    def test_rejects_multiline_commands(self):
        with self.assertRaises(ValueError):
            shell().run("echo a\necho b")


if __name__ == "__main__":
    unittest.main()
