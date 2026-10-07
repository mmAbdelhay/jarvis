#!/usr/bin/env python3
"""QEMU smoke tests for the Jarvis OS ISO (design §11; success criteria 1, 2, 12).

Boots the ISO headless (direct kernel boot with the ISO's own kernel, initrd
and boot line plus a harness-only serial debug shell), then drives the guest
over the serial console. The fake provider is switched on at runtime in
jarvis's user manager only; the ISO itself is the release image.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from jarvis_smoke import connectivity, qemu, ram, report, scenarios  # noqa: E402
from jarvis_smoke.serial_shell import CommandFailed, SerialShell, SerialTimeout  # noqa: E402

BOOTAPPEND = HERE.parent / "bootappend"


def build_assets(work: Path) -> Path:
    staging = work / "assets"
    shutil.copytree(HERE / "assets", staging, ignore=shutil.ignore_patterns("*.test.mjs"))
    image = work / "smoke-assets.iso"
    subprocess.run(
        ["xorriso", "-as", "mkisofs", "-quiet", "-V", "JARVISSMOKE", "-J", "-R", "-o", str(image), str(staging)],
        check=True,
    )
    return image


class Run:
    def __init__(self, shell: SerialShell, factor: int):
        self.shell = shell
        self.factor = factor
        self.results: list[dict] = []

    def sh(self, command: str, timeout: float = 120) -> str:
        return self.shell.run_ok(command, timeout * self.factor)

    def check(self, name: str, fn) -> bool:
        start = time.monotonic()
        try:
            detail = fn() or ""
            ok = True
        except (CommandFailed, SerialTimeout, AssertionError, ValueError) as error:
            ok, detail = False, str(error)
        seconds = round(time.monotonic() - start, 1)
        self.results.append({"name": name, "ok": ok, "seconds": seconds, "detail": str(detail)[-4000:]})
        print(f"[{'PASS' if ok else 'FAIL'}] {name} ({seconds}s)", flush=True)
        return ok


def run_checks(run: Run, args: argparse.Namespace) -> dict | None:
    sh = run.sh
    sh("dmesg -n 1")
    sh(scenarios.wait_for_user(150), 320)
    uid = int(sh("id -u jarvis").strip())
    ctl = lambda a: scenarios.jarvisctl(uid, a)  # noqa: E731

    run.check("criterion 1: boots into the Jarvis shell", lambda: sh(scenarios.wait_for_session(150), 320))

    def groups():
        have = set(sh("id -nG jarvis").split())
        missing = set(scenarios.REQUIRED_GROUPS) - have
        assert not missing, f"jarvis lacks groups {sorted(missing)} (has {sorted(have)})"

    run.check("session user groups", groups)
    def control_socket():
        sh(scenarios.wait_for_socket(60), 70)
        return sh(ctl("wait --timeout 60"), 70)

    run.check("jarvisd control socket", control_socket)

    ram_report: dict = {}

    def idle_ram():
        time.sleep(args.settle_seconds)
        samples = []
        for _ in range(3):
            samples.append(ram.used_mb(sh("cat /proc/meminfo")))
            time.sleep(5)
        used = statistics.median(samples)
        verdict = ram.verdict(used, args.ram_warn_mb, args.ram_fail_mb)
        ram_report.update(
            used_mb=round(used), samples=[round(s) for s in samples], verdict=verdict,
            warn_mb=args.ram_warn_mb, fail_mb=args.ram_fail_mb,
            top=sh("ps -eo rss,comm --sort=-rss | head -15"),
        )
        if verdict == "warn" and os.environ.get("GITHUB_ACTIONS"):
            print(f"::warning::idle RAM {used:.0f} MB is above the {args.ram_warn_mb} MB target", flush=True)
        assert verdict != "fail", f"idle RAM {used:.0f} MB is above the {args.ram_fail_mb} MB ceiling"
        return f"{used:.0f} MB ({verdict})"

    run.check("criterion 2: idle RAM", idle_ram)
    run.check("shell relaunches after a crash", lambda: sh(scenarios.shell_relaunches(20), 40))
    run.check("smoke assets mounted", lambda: sh(scenarios.mount_assets()))
    run.check(
        "connectivity baseline is full",
        lambda: sh(f"{scenarios.connectivity_setup(args.port)} && {scenarios.wait_connectivity_full(90)}", 200),
    )

    def polkit_for_jarvisd():
        for action in ("os.jarvis.helper.packages", "os.jarvis.helper.services"):
            sh(scenarios.polkit_grants(uid, action))

    run.check("polkit grants the helper to jarvisd", polkit_for_jarvisd)

    def apt_hello():
        sh(scenarios.use_fake_provider(uid, "install-hello.json"), 150)
        status, _ = run.shell.run(scenarios.DPKG_HELLO_INSTALLED)
        assert status != 0, "hello is already installed before the test"
        out = sh(ctl("prompt --text 'install hello' --approve-all --timeout 600"), 660)
        sh(scenarios.HELPER_WAS_ACTIVATED)
        sh(scenarios.APT_HISTORY_HELLO)
        sh(scenarios.DPKG_HELLO_INSTALLED)
        return out[-1500:]

    run.check("§11.1 pkg.install apt hello -> helper ran -> dpkg ii", apt_hello)

    def nm_restart_by_agent():
        sh(scenarios.use_fake_provider(uid, "net-restart.json"), 150)
        sh("systemctl stop NetworkManager")
        status, _ = run.shell.run("[ \"$(nmcli networking connectivity 2>/dev/null)\" = full ]")
        assert status != 0, "connectivity still full with NetworkManager stopped"
        out = sh(ctl("prompt --text \"my internet isn't working\" --approve-all --timeout 300"), 330)
        sh(scenarios.wait_connectivity_full(90), 100)
        return out[-1500:]

    run.check("§11.2 NetworkManager stopped -> agent restart -> connectivity full", nm_restart_by_agent)

    def doctor():
        sh(scenarios.use_fake_provider(uid, None), 150)
        sh("systemctl stop NetworkManager")
        out = sh(ctl("doctor --approve-all --timeout 300"), 330)
        sh(scenarios.wait_connectivity_full(90), 100)
        return out[-1500:]

    run.check("§11.3 provider unreachable + network down -> doctor -> full", doctor)
    return ram_report


def collect_diagnostics(shell: SerialShell, out: Path, uid: int = 1000) -> None:
    commands = {
        "system journal (jarvis-helper, NetworkManager)": "journalctl -b -u jarvis-helper -u NetworkManager --no-pager | tail -n 200",
        "jarvisd user journal": scenarios.as_user(uid, "journalctl --user -u jarvisd --no-pager") + " | tail -n 200",
        "audit log": "tail -n 50 /home/jarvis/.local/state/jarvis/audit.jsonl",
        "failed units": "systemctl --failed --no-pager",
    }
    with open(out / "diagnostics.txt", "w") as f:
        for title, command in commands.items():
            try:
                _, text = shell.run(command, 60)
            except (SerialTimeout, EOFError) as error:
                text = f"<{error}>"
            f.write(f"===== {title}\n{text}\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--iso", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--accel", choices=["auto", "kvm", "tcg"], default="auto")
    p.add_argument("--memory-mb", type=int, default=4096)
    p.add_argument("--ram-warn-mb", type=int, default=600)
    p.add_argument("--ram-fail-mb", type=int, default=900)
    p.add_argument("--settle-seconds", type=int, default=60)
    p.add_argument("--port", type=int, default=8099)
    args = p.parse_args(argv)

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    accel = qemu.detect_accel() if args.accel == "auto" else args.accel
    factor = 1 if accel == "kvm" else 4
    work = Path(tempfile.mkdtemp(prefix="jsmoke-"))  # short: Unix socket paths are limited
    kernel, initrd = qemu.extract_boot_files(args.iso, work)
    cfg = qemu.VmConfig(
        iso=args.iso.resolve(), assets=build_assets(work), kernel=kernel, initrd=initrd,
        append=qemu.kernel_append(BOOTAPPEND.read_text()),
        serial_socket=work / "serial.sock", qmp_socket=work / "qmp.sock",
        accel=accel, memory_mb=args.memory_mb,
    )
    server = connectivity.start(args.port)
    ram_report = None
    results: list[dict] = []
    with open(out / "qemu.log", "wb") as qlog, open(out / "serial.log", "wb") as slog:
        vm = subprocess.Popen(qemu.qemu_argv(cfg), stdout=qlog, stderr=subprocess.STDOUT)
        try:
            shell = SerialShell.connect_unix(str(cfg.serial_socket), log=slog, timeout=30)
            run = Run(shell, factor)
            if run.check("boot: root console", lambda: shell.wait_for_shell(300 * factor)):
                ram_report = run_checks(run, args) or None
                collect_diagnostics(shell, out)
            results = run.results
        finally:
            try:
                qemu.screendump(cfg.qmp_socket, (out / "screen.png").resolve())
            except (OSError, RuntimeError, ValueError):
                pass
            vm.terminate()
            try:
                vm.wait(30)
            except subprocess.TimeoutExpired:
                vm.kill()
            server.shutdown()
            shutil.rmtree(work, ignore_errors=True)

    summary = report.render_summary(results, ram_report, accel)
    (out / "summary.md").write_text(summary)
    (out / "results.json").write_text(json.dumps({"accel": accel, "results": results, "ram": ram_report}, indent=2))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary)
    print(summary)
    return 0 if results and all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
