"""QMP client for the install tests: typed keys (LUKS passphrase, greeter
password), screendumps (Plymouth prompt), power. Stdlib only."""
from __future__ import annotations

import json
import socket
import time
from pathlib import Path

PLAIN = {"-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right", "\\": "backslash",
         ";": "semicolon", "'": "apostrophe", "`": "grave_accent", ",": "comma", ".": "dot",
         "/": "slash", " ": "spc", "\n": "ret", "\t": "tab"}
SHIFTED = {"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9",
           ")": "0", "_": "minus", "+": "equal", "{": "bracket_left", "}": "bracket_right",
           "|": "backslash", ":": "semicolon", '"': "apostrophe", "~": "grave_accent", "<": "comma",
           ">": "dot", "?": "slash"}


class QmpError(RuntimeError):
    pass


def text_to_keys(text: str) -> list[list[str]]:
    keys = []
    for ch in text:
        if "a" <= ch <= "z" or "0" <= ch <= "9":
            keys.append([ch])
        elif "A" <= ch <= "Z":
            keys.append(["shift", ch.lower()])
        elif ch in PLAIN:
            keys.append([PLAIN[ch]])
        elif ch in SHIFTED:
            keys.append(["shift", SHIFTED[ch]])
        else:
            raise ValueError(f"no US-layout key for {ch!r}")
    return keys


class Qmp:
    def __init__(self, sock: socket.socket):
        self._sock = sock
        self._stream = sock.makefile("rwb")
        self.events: list[dict] = []

    @classmethod
    def connect(cls, path: str, timeout: float = 30.0) -> "Qmp":
        deadline = time.monotonic() + timeout
        while True:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.connect(path)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                sock.close()
                if time.monotonic() > deadline:
                    raise QmpError(f"no QMP socket at {path}") from None
                time.sleep(0.2)
        sock.settimeout(timeout)
        client = cls(sock)
        json.loads(client._stream.readline())  # greeting
        client.command("qmp_capabilities")
        return client

    def command(self, name: str, **arguments) -> object:
        message: dict = {"execute": name}
        if arguments:
            message["arguments"] = arguments
        self._stream.write(json.dumps(message).encode() + b"\n")
        self._stream.flush()
        while True:
            line = self._stream.readline()
            if not line:
                raise QmpError("QMP connection closed")
            reply = json.loads(line)
            if "event" in reply:
                self.events.append(reply)
            elif "error" in reply:
                raise QmpError(f"{name}: {reply['error']}")
            elif "return" in reply:
                return reply["return"]

    def send_keys(self, keys: list[str], hold_ms: int = 60) -> None:
        self.command("send-key", keys=[{"type": "qcode", "data": k} for k in keys], **{"hold-time": hold_ms})

    def type_text(self, text: str, delay: float = 0.08) -> None:
        for keys in text_to_keys(text):
            self.send_keys(keys)
            time.sleep(delay)

    def screendump(self, path: Path) -> Path:
        self.command("screendump", filename=str(path))  # PPM (P6)
        return path

    def powerdown(self) -> None:
        self.command("system_powerdown")

    def status(self) -> str:
        return self.command("query-status")["status"]

    def close(self) -> None:
        try:
            self._stream.close()
        finally:
            self._sock.close()
