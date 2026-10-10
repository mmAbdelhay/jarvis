"""QEMU command line and boot files for the smoke run.

The ISO is booted with QEMU's direct kernel boot, using the kernel and
initrd taken from the ISO itself and the ISO's own live command line
(os/iso/bootappend) plus a harness-only suffix. The ISO stays attached as a
CD so live-boot finds its squashfs; the image under test is the release image.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
from dataclasses import dataclass
from pathlib import Path

from jarvis_smoke import credentials
from jarvis_smoke.firmware import Ovmf

# console=ttyS0 makes systemd's getty generator start serial-getty@ttyS0,
# whose agetty hangs up ttyS0 and kills the debug shell mid-command; mask it.
HARNESS_APPEND = (
    "console=ttyS0,115200n8 systemd.debug_shell=ttyS0 systemd.mask=serial-getty@ttyS0.service loglevel=3"
)


def detect_accel(kvm: str = "/dev/kvm") -> str:
    return "kvm" if os.access(kvm, os.R_OK | os.W_OK) else "tcg"


def kernel_append(bootappend: str) -> str:
    line = " ".join(bootappend.split())
    for forbidden in ("debug_shell", "console=ttyS", "JARVIS_"):
        if forbidden in line:
            raise ValueError(f"the release boot line must not contain {forbidden!r}")
    return f"{line} {HARNESS_APPEND}"


def pick_boot_files(names: list[str]) -> tuple[str, str]:
    def pick(prefix: str) -> str:
        if prefix in names:
            return prefix
        versioned = sorted(n for n in names if n.startswith(prefix + "-"))
        if not versioned:
            raise FileNotFoundError(f"no {prefix} in /live of the ISO (found {names})")
        return versioned[-1]

    return pick("vmlinuz"), pick("initrd.img")


def list_live(iso: Path) -> list[str]:
    result = subprocess.run(
        ["xorriso", "-indev", str(iso), "-ls", "/live"], check=True, capture_output=True, text=True
    )
    return [Path(name).name for name in re.findall(r"'([^']+)'", result.stdout)]


def extract_boot_files(iso: Path, dest: Path) -> tuple[Path, Path]:
    kernel_name, initrd_name = pick_boot_files(list_live(iso))
    kernel, initrd = dest / "vmlinuz", dest / "initrd.img"
    subprocess.run(
        ["xorriso", "-osirrox", "on", "-indev", str(iso),
         "-extract", f"/live/{kernel_name}", str(kernel),
         "-extract", f"/live/{initrd_name}", str(initrd)],
        check=True, capture_output=True,
    )
    return kernel, initrd


@dataclass(frozen=True)
class VmConfig:
    iso: Path
    assets: Path
    kernel: Path
    initrd: Path
    append: str
    serial_socket: Path
    qmp_socket: Path
    accel: str
    memory_mb: int = 4096
    cpus: int = 2
    extra: tuple[str, ...] = ()  # appended to the QEMU command line (e.g. a USB tablet)


def qemu_argv(cfg: VmConfig) -> list[str]:
    if cfg.accel == "kvm":
        accel = ["-accel", "kvm", "-cpu", "host"]
    else:
        accel = ["-accel", "tcg,thread=multi", "-cpu", "max"]
    return [
        "qemu-system-x86_64", "-machine", "q35", *accel,
        "-m", str(cfg.memory_mb), "-smp", str(cfg.cpus),
        "-kernel", str(cfg.kernel), "-initrd", str(cfg.initrd), "-append", cfg.append,
        "-drive", f"file={cfg.iso},media=cdrom,readonly=on",
        "-drive", f"file={cfg.assets},format=raw,if=virtio,readonly=on",
        "-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0",
        "-vga", "none", "-device", "virtio-vga", "-display", "none",
        "-serial", f"unix:{cfg.serial_socket},server=on,wait=off",
        "-qmp", f"unix:{cfg.qmp_socket},server=on,wait=off",
        "-monitor", "none", *cfg.extra, "-no-reboot",
    ]


def screendump(qmp_socket: Path, target: Path, timeout: float = 10.0) -> None:
    """Saves the guest screen as PNG through QMP (for the CI artifact)."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(str(qmp_socket))
        stream = sock.makefile("rwb")
        json.loads(stream.readline())  # greeting
        commands = (
            {"execute": "qmp_capabilities"},
            {"execute": "screendump", "arguments": {"filename": str(target), "format": "png"}},
        )
        for command in commands:
            stream.write(json.dumps(command).encode() + b"\n")
            stream.flush()
            while True:
                reply = json.loads(stream.readline())
                if "error" in reply:
                    raise RuntimeError(reply["error"])
                if "return" in reply:
                    break


@dataclass(frozen=True)
class InstallVm:
    disks: tuple[Path, ...]  # first one is /dev/vda, the install target
    assets: Path
    serial_socket: Path
    qmp_socket: Path
    ovmf: Ovmf
    vars_path: Path
    accel: str
    iso: Path | None = None
    memory_mb: int = 4096
    cpus: int = 4
    network: bool = True  # False: no NIC at all (an offline install)


def install_qemu_argv(vm: InstallVm) -> list[str]:
    """Firmware boot through OVMF with Secure Boot (SMM, secure pflash)."""
    if vm.accel == "kvm":
        accel = ["-accel", "kvm", "-cpu", "host"]
    else:
        accel = ["-accel", "tcg,thread=multi", "-cpu", "max"]
    argv = [
        "qemu-system-x86_64", "-machine", "q35,smm=on", *accel,
        "-m", str(vm.memory_mb), "-smp", str(vm.cpus),
        "-global", "driver=cfi.pflash01,property=secure,value=on",
        "-drive", f"if=pflash,format=raw,unit=0,readonly=on,file={vm.ovmf.code}",
        "-drive", f"if=pflash,format=raw,unit=1,file={vm.vars_path}",
    ]
    for disk in vm.disks:
        argv += ["-drive", f"file={disk},format=raw,if=virtio,cache=unsafe"]
    argv += ["-drive", f"file={vm.assets},format=raw,if=virtio,readonly=on"]
    if vm.iso is not None:
        argv += ["-drive", f"file={vm.iso},media=cdrom,readonly=on"]
    argv += ["-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0"] if vm.network else ["-nic", "none"]
    argv += [
        "-vga", "none", "-device", "virtio-vga", "-display", "none",
        "-serial", f"unix:{vm.serial_socket},server=on,wait=off",
        "-qmp", f"unix:{vm.qmp_socket},server=on,wait=off",
        "-monitor", "none", "-no-reboot",
        *credentials.smbios_args(),
    ]
    return argv
