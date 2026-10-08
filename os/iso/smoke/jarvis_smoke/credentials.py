"""A root shell on ttyS0 for the install tests, passed by QEMU as systemd
credentials over SMBIOS type 11 (systemd >= 256: systemd.extra-unit.* and
systemd.unit-dropin.*). Nothing is in the image: systemd imports SMBIOS
credentials only inside a VM, from the hypervisor, which owns the VM anyway.
Works for the live ISO and the installed system after the disk is unlocked,
with the release boot line untouched (unlike M1's debug_shell)."""
from __future__ import annotations

import base64

TEST_SHELL_UNIT = """[Unit]
Description=Install-test root shell on ttyS0 (QEMU SMBIOS credential, never in the image)
DefaultDependencies=no
IgnoreOnIsolate=yes
ConditionVirtualization=vm

[Service]
Environment=TERM=linux
ExecStart=/bin/sh
Restart=always
RestartSec=0
StandardInput=tty
TTYPath=/dev/ttyS0
TTYReset=yes
TTYVHangup=yes
KillMode=process
IgnoreSIGPIPE=no
SendSIGHUP=yes
"""

WANTS_DROPIN = "[Unit]\nWants=jarvis-test-shell.service\n"


def _credential(name: str, text: str) -> list[str]:
    b64 = base64.b64encode(text.encode()).decode()
    return ["-smbios", f"type=11,value=io.systemd.credential.binary:{name}={b64}"]


def smbios_args() -> list[str]:
    return (_credential("systemd.extra-unit.jarvis-test-shell.service", TEST_SHELL_UNIT)
            + _credential("systemd.unit-dropin.sysinit.target~jarvis-test-shell", WANTS_DROPIN))
