"""Guest command lines for the install tests (one POSIX sh line each, run
as root in the SMBIOS test shell). The backend is driven over its D-Bus API
(contracts §1) by assets/installctl.mjs; the installer UI is Plan E's and
tested by its QML tests."""
from __future__ import annotations

import base64
import json

from jarvis_smoke.scenarios import ASSETS, NODE

USER = "tester"
PASSWORD = "tester-pass-42"
PASSPHRASE = "correct-horse-42"
WRONG_PASSPHRASE = "wrong-horse-00"
HOSTNAME = "testbox"
LIVE_USER = "jarvis"


def choices(disk: str, mode: str, *, alongside_bytes: int | None = None, encrypt: bool = True) -> dict:
    d: dict = {"path": disk, "mode": mode}
    if mode == "alongside":
        if alongside_bytes is None:
            raise ValueError("alongside needs alongside_bytes")
        d["alongsideSizeBytes"] = alongside_bytes
    return {
        "locale": "en_US.UTF-8", "keyboard": "us", "timezone": "Etc/UTC",
        "disk": d, "encrypt": encrypt,
        "user": {"fullName": "Test User", "username": USER, "hostname": HOSTNAME, "autologin": False},
        "brain": {"kind": "cloud"},
    }


def write_json(path: str, obj) -> str:
    b64 = base64.b64encode(json.dumps(obj).encode()).decode()
    return f"echo {b64} | base64 -d > {path} && chmod 0600 {path}"


def installctl(args: str) -> str:
    return f"{NODE} {ASSETS}/installctl.mjs {args} --as-user {LIVE_USER}"


def probe() -> str:
    return installctl("probe")


def plan(c: dict) -> str:
    return f"{write_json('/run/inst-choices.json', c)} && {installctl('plan --choices /run/inst-choices.json --out /run/inst-plan.json')}"


def execute(timeout_s: int) -> str:
    secrets = {"userPassword": PASSWORD, "luksPassphrase": PASSPHRASE}
    return (f"{write_json('/run/inst-secrets.json', secrets)} && "
            f"{installctl(f'execute --plan /run/inst-plan.json --secrets /run/inst-secrets.json --timeout {timeout_s}')}")


def luks2_on(disk: str) -> str:
    return (f"p=$(lsblk -nrpo NAME,FSTYPE {disk} | awk '$2==\"crypto_LUKS\" {{print $1; exit}}') && [ -n \"$p\" ] "
            f"&& cryptsetup luksDump \"$p\" | grep -Eq '^Version:[[:space:]]+2'")
