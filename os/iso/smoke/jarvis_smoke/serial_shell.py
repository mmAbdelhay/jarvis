"""A root shell on the guest's first serial port, driven by unique markers.

The smoke boot (and only the smoke boot) adds `systemd.debug_shell=ttyS0` to
the kernel command line, which starts a root shell on ttyS0 with no login.
QEMU exposes ttyS0 as a Unix socket. SerialShell writes one command line at a
time and reads until an end marker carrying the exit status.

Markers are produced by shell arithmetic (`$((0))` prints `0`), so the tty's
echo of the typed line, which contains `$((0))` literally, never matches. Each
command runs in a subshell, so `exit` inside it cannot end the console.
"""

from __future__ import annotations

import re
import socket
import time
import uuid
from typing import BinaryIO

MAX_LINE = 3500  # below the tty's 4095-byte canonical line limit


class SerialTimeout(Exception):
    pass


class CommandFailed(Exception):
    def __init__(self, command: str, status: int, output: str):
        super().__init__(f"exit {status}: {command}\n{output[-2000:]}")
        self.command = command
        self.status = status
        self.output = output


class SerialShell:
    def __init__(self, sock: socket.socket, log: BinaryIO | None = None):
        self._sock = sock
        self._log = log
        self._buf = b""

    @classmethod
    def connect_unix(cls, path: str, log: BinaryIO | None = None, timeout: float = 60.0) -> "SerialShell":
        deadline = time.monotonic() + timeout
        while True:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.connect(path)
                return cls(sock, log)
            except (FileNotFoundError, ConnectionRefusedError):
                sock.close()
                if time.monotonic() > deadline:
                    raise SerialTimeout(f"no serial socket at {path}") from None
                time.sleep(0.5)

    def _fill(self, deadline: float) -> None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SerialTimeout("the serial console did not answer in time")
        self._sock.settimeout(min(remaining, 1.0))
        try:
            chunk = self._sock.recv(65536)
        except socket.timeout:
            return
        if not chunk:
            raise EOFError("the serial console closed")
        if self._log is not None:
            self._log.write(chunk)
            self._log.flush()
        self._buf += chunk

    def _expect(self, pattern: re.Pattern[bytes], deadline: float) -> re.Match[bytes]:
        while True:
            match = pattern.search(self._buf)
            if match:
                return match
            self._fill(deadline)

    def wait_for_shell(self, timeout: float) -> None:
        """Pokes the console every 5 s until a shell answers."""
        deadline = time.monotonic() + timeout
        while True:
            token = uuid.uuid4().hex[:12]
            self._sock.sendall(f"\necho R{token}$((0))\n".encode())
            try:
                self._expect(re.compile(b"R" + token.encode() + b"0"), min(deadline, time.monotonic() + 5))
                self._buf = b""
                return
            except SerialTimeout:
                if time.monotonic() >= deadline:
                    raise SerialTimeout(f"no shell on the serial console after {timeout:.0f}s") from None

    def run(self, command: str, timeout: float = 120.0) -> tuple[int, str]:
        if "\n" in command:
            raise ValueError("one line per command")
        token = uuid.uuid4().hex[:12]
        line = f"echo B{token}$((0)); ( {command} ) </dev/null 2>&1; echo E{token}$((0)):$?\n"
        if len(line) > MAX_LINE:
            raise ValueError(f"command too long for the tty ({len(line)} bytes)")
        self._sock.sendall(line.encode())
        deadline = time.monotonic() + timeout
        try:
            begin = self._expect(re.compile(b"B" + token.encode() + rb"0\r?\n"), deadline)
            self._buf = self._buf[begin.end():]
            end = self._expect(re.compile(b"E" + token.encode() + rb"0:(\d+)"), deadline)
        except SerialTimeout:
            self._sock.sendall(b"\x03")  # interrupt, so the next command gets the shell
            raise
        output = self._buf[: end.start()].decode("utf-8", "replace").replace("\r\n", "\n")
        self._buf = self._buf[end.end():]
        return int(end.group(1)), output

    def run_ok(self, command: str, timeout: float = 120.0) -> str:
        status, output = self.run(command, timeout)
        if status != 0:
            raise CommandFailed(command, status, output)
        return output
