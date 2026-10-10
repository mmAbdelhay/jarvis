#!/usr/bin/env python3
"""Computer use in the Rafiq ISO under KVM (v1.1 design §2).

Boots the release ISO like run_smoke.py (direct kernel boot, serial debug
shell) plus a USB tablet, installs GIMP in the live session, points jarvisd at
the scripted vision model (assets/cu/fakevision.mjs) and checks what needs the
real session: jarvis-cu started by the autostart under systemd, the peer
check, the overlay border, real (QMP) pointer input pausing
Jarvis, and Super+L ending it. The lock check is last: it leaves the screen locked.

The GIMP export runs mouse only through both Export dialogs (cu-gimp.json):
the deny turn denies the consequential card and leaves no file, the export
turn approves it and writes Pictures/beach.png (criteria 1 and 5).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from jarvis_smoke import cu, qemu, report, scenarios  # noqa: E402
from jarvis_smoke.qmp import Qmp  # noqa: E402
from jarvis_smoke.serial_shell import SerialShell, SerialTimeout  # noqa: E402
from run_smoke import BOOTAPPEND, Run, build_assets  # noqa: E402

USB_TABLET = ("-device", "qemu-xhci", "-device", "usb-tablet")


def run_checks(run: Run, args: argparse.Namespace, qmp: Qmp, out: Path) -> int:
    sh = run.sh
    sh("dmesg -n 1")
    if args.disable_jarvis_apt:
        sh(scenarios.DISABLE_JARVIS_APT)
    sh(scenarios.wait_for_user(150), 320)
    uid = int(sh("id -u jarvis").strip())
    run.check("session: labwc and jarvis-shell run", lambda: sh(scenarios.wait_for_session(150), 320))
    run.check("smoke assets mounted", lambda: sh(scenarios.mount_assets()))
    sh(cu.prepare_logs())
    run.check("contracts §1: the autostart started jarvis-cu.service", lambda: sh(cu.wait(cu.helper_active(uid), 60), 80))
    run.check("contracts §1: cu.sock is 0600", lambda: sh(cu.socket_private(uid)))
    run.check("Review Focus 3: a plain Node process is refused on cu.sock", lambda: sh(cu.peer_probe(uid), 30))
    run.check("Review Focus 3: Node running jarvisd's script with another argv is refused",
              lambda: sh(cu.peer_probe(uid, jarvisd_argv=True), 30))
    run.check("GIMP installed from Debian (network)", lambda: sh(cu.INSTALL_GIMP, 1200))
    run.check("the scripted vision model listens on loopback", lambda: sh(cu.start_fakevision(uid), 60))
    run.check("jarvisd runs on the scripted vision model", lambda: sh(cu.use_scripted_provider(uid), 150))
    run.check("beach.xcf made by GIMP's batch mode", lambda: sh(cu.make_fixture(uid), 300))

    def gimp():
        sh(cu.start_gimp(uid), 150)
        time.sleep(30 * run.factor)

    run.check("GIMP shows beach.xcf in the session", gimp)

    def border_before():
        ratio = cu.frame_teal_ratio(*cu.read_ppm(qmp.screendump((out / "before-cu.ppm").resolve())))
        assert ratio < 0.5, f"{ratio:.2f} of the screen edge is already teal; the border check would prove nothing"
        return f"{ratio:.2f}"

    run.check("no teal border before computer use", border_before)

    def off():
        sh(cu.turn(uid, "off", "cu-off: look at my screen"), 200)
        sh(cu.cucheck(uid, f"no-screen-tools {cu.REPORT} off"))

    run.check("criterion 2: off by default, no screen tools reach the model", off)
    run.check("computer use enabled for the scripted provider", lambda: sh(cu.enable(uid), 60))

    # Criteria 1 and 5 (as in os/iso/cu/session.sh): GIMP's Export Image dialog's Export
    # button is consequential; its card comes before the click.
    def deny():
        sh(cu.turn(uid, "deny", "cu-deny: export beach as PNG to Pictures",
                   f"--consequential deny --absent {cu.PNG_TARGET}"), 700)
        sh(cu.cucheck(uid, f"turn {cu.REPORT} deny --images --strict"))

    run.check("the deny turn ran as scripted (card denied, then Cancel)", deny)
    run.check("criterion 5: a consequential card before the export click",
              lambda: sh(cu.cucheck(uid, f"card {cu.log('deny')} consequential --absent --title-has Export")))
    run.check("criterion 5: denying it leaves no file", lambda: sh(f"[ ! -e {cu.PNG_TARGET} ]"))

    def export():
        sh(cu.turn(uid, "export", "open the GIMP image beach.xcf and export it as PNG to Pictures",
                   f"--absent {cu.PNG_TARGET}"), 700)
        sh(cu.cucheck(uid, f"turn {cu.REPORT} export --images --strict"))

    run.check("the export turn ran as scripted", export)
    run.check("criterion 5: the approved export asked first, before the file existed",
              lambda: sh(cu.cucheck(uid, f"card {cu.log('export')} consequential --absent --title-has Export")))
    run.check("criterion 1: GIMP export to Pictures through computer use",
              lambda: sh(cu.wait(cu.cucheck(uid, f"png {cu.PNG_TARGET} 640 480"), 20), 40))

    def border_during():
        sh(cu.turn(uid, "physical", "cu-physical: hold the session", background=True))
        sh(cu.wait_check(uid, f"active {cu.log('physical')}", 90), 120)
        ratio = cu.frame_teal_ratio(*cu.read_ppm(qmp.screendump((out / "during-cu.ppm").resolve())))
        assert ratio >= 0.9, f"only {ratio:.2f} of the screen edge is teal while Jarvis controls the screen"
        return f"{ratio:.2f}"

    run.check("criterion 3: a teal border while Jarvis controls the screen", border_during)

    def physical():
        t0 = int(sh("date +%s%3N").strip())
        qmp.move_pointer_abs(8000, 8000)
        qmp.move_pointer_abs(20000, 14000)
        sh(cu.wait_check(uid, f"paused {cu.log('physical')} physical-input --since {t0} --within 2000", 10), 30)
        sh(cu.stop(uid), 30)

    run.check("criterion 3: real pointer motion pauses Jarvis within 2 s", physical)

    # Final review finding 4: the keyboard Take over is Super+Esc (labwc bind ->
    # jarvis-session-key --cu-stop -> jarvis-shell -> cu:stop). The bound here is the
    # serial-shell and QMP round trip, not the 200 ms target; that is not measured.
    def takeover():
        sh(cu.turn(uid, "takeover", "cu-takeover: hold the session", background=True))
        sh(cu.wait_check(uid, f"active {cu.log('takeover')}", 90), 120)
        t0 = int(sh("date +%s%3N").strip())
        qmp.send_keys(["meta_l", "esc"])
        sh(cu.wait_check(uid, f"paused {cu.log('takeover')} stopped --since {t0} --within 2000", 10), 30)

    run.check("criterion 3: Super+Esc takes over (computer use stops) within 2 s", takeover)
    run.check("criterion 8: the audit log has the goal", lambda: sh(cu.AUDIT_HAS_GOAL))
    run.check("criterion 8: the audit log has the screen actions", lambda: sh(cu.AUDIT_HAS_ACTIONS))
    run.check("criterion 8: no screenshot stored in jarvis's directories, /tmp, the test logs or the journals",
              lambda: sh(cu.no_screenshots_stored(uid)))
    run.check("criterion 6: no screenshot leaked a foreign window, none outside computer-use turns",
              lambda: sh(cu.cucheck(uid, f"no-leaks {cu.REPORT}")))
    # Under U-1 every ordinary capture here is fullscreen: the mask is vacuous, so the check above
    # can pass without testing a pixel. Privacy is verified only when at least one capture was
    # really checked (an all-black frame); otherwise it is reported BLOCKED, not passed.
    if not run.check("criterion 6: at least one screenshot was really checked for leaks",
                     lambda: sh(cu.cucheck(uid, f"no-leaks {cu.REPORT} --min-verified 1"))):
        failed = run.results.pop()
        run.results.append(report.blocked(failed["name"], "U-1: every capture was vacuous (allowed window = whole frame); "
                                          "the all-black evidence is only produced by the container tier's excluded turn"))

    def lock():
        sh(cu.turn(uid, "lock", "cu-lock: hold the session", background=True))
        sh(cu.wait_check(uid, f"active {cu.log('lock')}", 90), 120)
        t0 = int(sh("date +%s%3N").strip())
        qmp.send_keys(["meta_l", "l"])
        sh(cu.wait_check(uid, f"paused {cu.log('lock')} locked --since {t0} --within 2000", 10), 30)
        sh(cu.wait(f"pgrep -u {scenarios.USER} -x jarvis-lock >/dev/null", 10), 20)

    run.check("criterion 9: Super+L ends computer use within 2 s", lock)
    return uid


def collect(shell: SerialShell, out: Path, uid: int) -> None:
    items = {
        "fakevision-report.json": f"cat {cu.REPORT}",
        "turn-logs.txt": f"tail -n 200 {cu.LOGS}/turn-*.log",
        "jarvisd.journal.txt": scenarios.as_user(uid, "journalctl --user -u jarvisd --no-pager") + " | tail -n 300",
        "jarvis-cu.journal.txt": scenarios.as_user(uid, "journalctl --user -u jarvis-cu --no-pager") + " | tail -n 200",
        "gimp.log": f"tail -n 100 {cu.LOGS}/gimp.log",
    }
    for name, command in items.items():
        try:
            _, text = shell.run(command, 60)
        except (SerialTimeout, EOFError, OSError) as error:
            text = f"<{error}>"
        (out / name).write_text(text)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--iso", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--accel", choices=["auto", "kvm", "tcg"], default="auto")
    p.add_argument("--memory-mb", type=int, default=6144)
    p.add_argument("--disable-jarvis-apt", action="store_true")
    args = p.parse_args(argv)

    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    accel = qemu.detect_accel() if args.accel == "auto" else args.accel
    factor = 1 if accel == "kvm" else 4
    work = Path(tempfile.mkdtemp(prefix="jcu-"))  # short: Unix socket paths are limited
    kernel, initrd = qemu.extract_boot_files(args.iso, work)
    cfg = qemu.VmConfig(
        iso=args.iso.resolve(), assets=build_assets(work), kernel=kernel, initrd=initrd,
        append=qemu.kernel_append(BOOTAPPEND.read_text()),
        serial_socket=work / "serial.sock", qmp_socket=work / "qmp.sock",
        accel=accel, memory_mb=args.memory_mb, extra=USB_TABLET,
    )
    results: list[dict] = []
    with open(out / "qemu.log", "wb") as qlog, open(out / "serial.log", "wb") as slog:
        vm = subprocess.Popen(qemu.qemu_argv(cfg), stdout=qlog, stderr=subprocess.STDOUT)
        qmp = None
        try:
            qmp = Qmp.connect(str(cfg.qmp_socket))
            shell = SerialShell.connect_unix(str(cfg.serial_socket), log=slog, timeout=30)
            run = Run(shell, factor)
            if run.check("boot: root console", lambda: shell.wait_for_shell(300 * factor)):
                uid = run_checks(run, args, qmp, out)
                collect(shell, out, uid)
            results = run.results
        finally:
            if qmp is not None:
                try:
                    qmp.screendump(out / "screen.ppm")
                except (OSError, RuntimeError, ValueError):
                    pass
                qmp.close()
            vm.terminate()
            try:
                vm.wait(30)
            except subprocess.TimeoutExpired:
                vm.kill()
            shutil.rmtree(work, ignore_errors=True)

    summary = report.render_summary(results, None, accel)
    (out / "summary.md").write_text(summary)
    (out / "results.json").write_text(json.dumps({"accel": accel, "results": results}, indent=2))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary)
    print(summary)
    blocked = [r for r in results if r.get("blocked")]
    if blocked:
        print(f"passed, but {len(blocked)} BLOCKED criteria are NOT verified (release blocker)")
    return report.exit_code(results, os.environ.get("CU_FAIL_ON_BLOCKED") == "1")


if __name__ == "__main__":
    sys.exit(main())
