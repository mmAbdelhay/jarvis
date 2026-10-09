#!/usr/bin/env python3
"""Install tests: the ISO booted through OVMF with Secure Boot and Microsoft
keys (M2 design §13; criteria 1-7, 10, 12; contracts §11.5 keyboard chain). The release image is unchanged:
the root shell on ttyS0 comes from a systemd credential that QEMU passes over
SMBIOS. The backend is driven over D-Bus (installctl.mjs); the disk
passphrase and the greeter password are typed with QMP send-key."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from jarvis_smoke import disks, firmware, qemu, report, scenarios, screen  # noqa: E402
from jarvis_smoke import install_flow as flow  # noqa: E402
from jarvis_smoke.qmp import Qmp  # noqa: E402
from jarvis_smoke.serial_shell import SerialShell, SerialTimeout  # noqa: E402
from run_smoke import Run, build_assets  # noqa: E402

BRAND_ENV = HERE.parent.parent / "branding" / "brand.env"
GIB = 1 << 30
# The erase install chooses a non-US keyboard and types the disk passphrase
# and the greeter password with it: Plymouth, the greeter's cage and the
# user's labwc must all use /etc/default/keyboard (contracts §11.5).
ERASE_KEYBOARD = "de"
# make-windows-disk.sh state -> the Plan refusal key (criterion 4).
REFUSALS = {"hibernated": "ntfs-hibernated", "bitlocker": "ntfs-bitlocker", "dirty": "ntfs-dirty"}
# The local model needs minRamGB 8 (ModelFits) and a target over 30 GiB + model.
LOCAL_MODEL_RAM_MB = 8192


def brand(path: Path) -> dict[str, str]:
    values = dict(re.findall(r'^([A-Z_]+)="([^"]*)"$', path.read_text(), re.M))
    values["PRETTY_NAME"] = f"{values['DISTRO_NAME']} {values['DISTRO_VERSION']} (trixie)"
    return values


def target_checks(b: dict[str, str]) -> list[tuple[str, str]]:
    secrets = f"-e '{flow.PASSPHRASE}' -e '{flow.PASSWORD}'"
    return [
        ("criterion 1: Secure Boot still enabled (mokutil --sb-state)",
         "mokutil --sb-state | grep -qx 'SecureBoot enabled'"),
        ("os-release is the brand (design §11, contracts §9)",
         f". /etc/os-release && [ \"$ID\" = '{b['DISTRO_ID']}' ] && [ \"$PRETTY_NAME\" = '{b['PRETTY_NAME']}' ] && [ \"$ID_LIKE\" = debian ]"),
        ("criterion 2: root is on the unlocked LUKS device", "findmnt -no SOURCE / | grep -q '^/dev/mapper/'"),
        ("live-only packages removed",
         "! dpkg-query -W -f='${Status}\\n' jarvis-installer jarvis-installer-backend live-boot live-config 2>/dev/null | grep -q 'install ok installed'"),
        ("greeter, not autologin (Review Focus 1)",
         "! grep -q '^\\[initial_session\\]' /etc/greetd/config.toml && for i in $(seq 90); do pgrep -u _greetd -x jarvis-greeter >/dev/null && exit 0; sleep 1; done; exit 1"),
        ("ollama answers on 127.0.0.1:11434 only (contracts §7)",
         "systemctl is-active -q ollama && ss -Hltn 'sport = :11434' | awk '{print $4}' | grep -qx '127.0.0.1:11434' && [ -z \"$(ss -Hltn 'sport = :11434' | awk '{print $4}' | grep -vx '127.0.0.1:11434')\" ]"),
        ("APT source and archive keyring installed (criterion 10)",
         "test -f /etc/apt/sources.list.d/jarvis.sources && test -s /usr/share/keyrings/jarvis-archive-keyring.gpg"),
        ("secrets never in the installer log", f"test -f /var/log/jarvis-installer.log && ! grep -qF {secrets} /var/log/jarvis-installer.log"),
    ]


def boot_checks() -> list[tuple[str, str]]:
    """M2 contracts §12: an encrypted install boots from a separate,
    unencrypted ext4 /boot labelled "$DISTRO_NAME boot" (Debian's signed GRUB cannot
    read the argon2id LUKS2 root); the kernel and initramfs live there and
    the passphrase is asked by Plymouth in the initramfs."""
    label = f"{brand(BRAND_ENV)['DISTRO_NAME']} boot"
    src = "$(findmnt -no SOURCE /boot)"
    # The serial shell answers seconds after the unlock, while systemd is
    # still mounting the fstab entries: wait for local-fs.target first (a
    # failed /boot mount leaves it inactive, so the checks still fail).
    mounted = "for i in $(seq 90); do systemctl is-active -q local-fs.target && break; sleep 1; done; "
    return [
        (f"§12: /boot is a separate unencrypted ext4 partition labelled '{label}'",
         f"{mounted}findmnt -no FSTYPE /boot | grep -qx ext4 && case \"{src}\" in /dev/mapper/*) exit 1;; esac && "
         f"[ \"$(blkid -s LABEL -o value {src})\" = '{label}' ] && [ \"$(lsblk -no TYPE {src})\" = part ]"),
        ("§12: fstab mounts /boot by UUID; /boot holds the kernel and initramfs; GRUB reads it",
         "grep -Eq '^UUID=[0-9a-f-]+ /boot ext4 ' /etc/fstab && ls /boot/vmlinuz-* /boot/initrd.img-* >/dev/null && "
         "test -s /boot/grub/grub.cfg && ! grep -q '^GRUB_ENABLE_CRYPTODISK=y' /etc/default/grub /etc/default/grub.d/*.cfg 2>/dev/null"),
        ("§12: the initramfs carries cryptsetup and asks for the passphrase (crypttab unchanged)",
         "grep -Eq '^jarvis-root UUID=[0-9a-f-]+ none luks,discard,initramfs,tries=0$' /etc/crypttab && "
         "lsinitramfs /boot/initrd.img-$(uname -r) | grep -q 'cryptsetup'"),
    ]


def keyboard_checks(layout: str) -> list[tuple[str, str]]:
    """contracts §11.5, in order: the file (before login), the greeter's cage
    (before login) and a child of the user's labwc (after login: labwc
    applies its environment file over what the wrapper exported, so only
    what it launched shows the effective layout)."""
    env = "tr '\\0' '\\n' < /proc/$pid/environ | grep -qx XKB_DEFAULT_LAYOUT=" + layout
    return [
        ("§11.5: /etc/default/keyboard has the chosen layout", f"grep -qx 'XKBLAYOUT=\"{layout}\"' /etc/default/keyboard"),
        ("§11.5: the unlock prompt's layout is in the initramfs (vconsole.conf + XKB data + evdev for Plymouth)",
         f"grep -Eqx 'XKBLAYOUT=\"?{layout}\"?' /etc/vconsole.conf && lsinitramfs /boot/initrd.img-$(uname -r) | grep -qx 'etc/vconsole.conf' && "
         f"lsinitramfs /boot/initrd.img-$(uname -r) | grep -qx 'usr/share/X11/xkb/symbols/{layout}' && "
         f"lsinitramfs /boot/initrd.img-$(uname -r) | grep -q '/evdev\\.ko'"),
        ("§11.5: the greeter's cage types with the chosen layout",
         f"for i in $(seq 90); do pid=$(pgrep -u _greetd -x cage | head -n1); [ -n \"$pid\" ] && break; sleep 1; done; "
         f"[ -n \"$pid\" ] && {env}"),
        ("§11.5: the user's labwc session types with the chosen layout",
         f"pid=$(pgrep -u {flow.USER} -x jarvis-shell | head -n1) && [ -n \"$pid\" ] && {env}"),
    ]


def model_checks(user: str) -> list[tuple[str, str]]:
    """Criterion 7 after an offline install: first boot fetches the model."""
    state = "/var/lib/jarvis/model-state.json"
    yaml = f"/home/{user}/.config/jarvis/jarvis.yaml"
    return [
        ("criterion 7: offline install left the model for first boot",
         "grep -q 'model: offline' /var/log/jarvis-installer.log"),
        ("criterion 7: jarvis-model-fetch finishes on first boot (model-state ready, marker gone)",
         f"for i in $(seq 360); do grep -q '\"state\":\"ready\"' {state} && ! test -e /var/lib/jarvis/model-pending && exit 0; "
         f"sleep 5; done; cat {state}; systemctl status --no-pager jarvis-model-fetch; exit 1"),
        ("criterion 7: ollama lists the local model",
         f"HOME=/root ollama list | awk 'NR>1 {{print $1}}' | grep -qx '{flow.LOCAL_MODEL_TAG}'"),
        ("contracts §6: the user's jarvis.yaml points at the local ollama model",
         f"[ \"$(stat -c %U:%a {yaml})\" = {user}:600 ] && grep -qx '  kind: ollama' {yaml} "
         f"&& grep -qx '  baseUrl: \"http://127.0.0.1:11434\"' {yaml} && grep -qx '  model: \"{flow.LOCAL_MODEL_TAG}\"' {yaml}"),
    ]


def shrunk_ok(before: disks.Part, after: disks.Part, given_bytes: int) -> bool:
    """Alongside only shrinks the Windows partition, never moves its start (§14)."""
    return after.start == before.start and after.size * 512 <= before.size * 512 - given_bytes + 64 * (1 << 20)


class Machine:
    def __init__(self, name: str, vm: qemu.InstallVm, out: Path):
        self.name, self.vm, self.out = name, vm, out

    def __enter__(self) -> "Machine":
        self.qlog = open(self.out / f"{self.name}-qemu.log", "wb")
        self.slog = open(self.out / f"{self.name}-serial.log", "wb")
        self.proc = subprocess.Popen(qemu.install_qemu_argv(self.vm), stdout=self.qlog, stderr=subprocess.STDOUT)
        self.qmp = Qmp.connect(str(self.vm.qmp_socket), 30)
        self.serial = SerialShell.connect_unix(str(self.vm.serial_socket), log=self.slog, timeout=30)
        return self

    def screen(self, tag: str) -> screen.Image:
        path = (self.out / f"{self.name}-{tag}.ppm").resolve()
        self.qmp.screendump(path)
        return screen.read_ppm(path)

    def wait_prompt(self, timeout: float, *, empty: bool = False) -> screen.Box:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            img = self.screen("prompt")
            box = screen.find_prompt(img)
            if box and (not empty or screen.bullet_pixels(img, box) == 0):
                return box
            time.sleep(2)
        raise AssertionError(f"no Plymouth unlock prompt in {timeout:.0f}s (see {self.name}-prompt.ppm)")

    def poweroff(self, timeout: float = 180) -> None:
        try:
            self.serial.run("systemctl poweroff", 15)
        except (SerialTimeout, EOFError, OSError):
            pass
        try:
            self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.qmp.powerdown()
            self.proc.wait(60)

    def __exit__(self, *exc) -> None:
        if self.proc.poll() is None:
            try:
                self.screen("final")
            except (OSError, RuntimeError):
                pass
            self.proc.kill()
            self.proc.wait(30)
        for f in (self.qlog, self.slog):
            f.close()


def live_vm(args, work: Path, disks_: tuple[Path, ...], vars_path: Path, ovmf: firmware.Ovmf, assets: Path, tag: str,
            **extra) -> qemu.InstallVm:
    return qemu.InstallVm(disks=disks_, assets=assets, serial_socket=work / f"s-{tag}.sock",
                          qmp_socket=work / f"q-{tag}.sock", ovmf=ovmf, vars_path=vars_path,
                          accel=args.accel, iso=args.iso.resolve(), **extra)


def live_session(run: Run, m: Machine) -> bool:
    sh = run.sh

    def boot():
        m.serial.wait_for_shell(600 * run.factor, via_grub=True)
        sh("mokutil --sb-state | grep -qx 'SecureBoot enabled'")

    if not run.check("criterion 1: ISO boots through shim with Secure Boot on", boot):
        return False
    run.check("live: session and installer start", lambda: (
        sh(scenarios.wait_for_user(150), 320), sh(scenarios.wait_for_session(150), 320),
        sh(f"for i in $(seq 60); do pgrep -u {flow.LIVE_USER} -f '(^|/)jarvis-installer( |$)' >/dev/null && exit 0; sleep 2; done; exit 1", 140)))
    run.check("live: smoke assets mounted", lambda: sh(scenarios.mount_assets()))
    run.check("live: ollama does not run in the live session", lambda: sh("! systemctl is-active -q ollama"))
    run.check("live: Probe sees UEFI, Secure Boot and the catalog", lambda: sh(
        flow.probe() + " | grep -q '\"uefi\":true' && " + flow.probe() + " | grep -q '\"secureBoot\":true'"))
    return True


def install(run: Run, choices: dict, target: Path, before: str) -> bool:
    sh = run.sh

    def plan_only():
        sh(flow.plan(choices), 120)
        assert disks.sparse_digest(target) == before, "a disk changed before Install (criterion 5)"

    run.check("criterion 5: Plan alone writes nothing", plan_only)
    return run.check("install finishes (Execute → Finished ok)", lambda: sh(flow.execute(2400), 2500))


def unlock(run: Run, m: Machine, *, wrong_first: bool, layout: str = "us") -> bool:
    def wrong_three_times():
        box = m.wait_prompt(300 * run.factor)
        m.qmp.type_text(flow.WRONG_PASSPHRASE, layout=layout)
        img = m.screen("typed")
        assert screen.bullet_pixels(img, box) > 0, "typed keys did not reach the prompt"
        m.qmp.type_text("\n", layout=layout)
        for _attempt in (2, 3):
            time.sleep(1)
            m.wait_prompt(120, empty=True)
            m.qmp.type_text(flow.WRONG_PASSPHRASE + "\n", layout=layout)
        time.sleep(1)
        m.wait_prompt(120, empty=True)
        time.sleep(10)
        assert screen.find_prompt(m.screen("after-3-wrong")), "the prompt went away after 3 wrong passphrases"
        try:
            m.serial.wait_for_shell(15, via_grub=True)
        except SerialTimeout:
            return "still asking, no shell"
        raise AssertionError("the system came up without the passphrase")

    if wrong_first:
        run.check("criterion 2 / §12: 3 wrong passphrases → still asking, never a shell", wrong_three_times)

    def right():
        if not wrong_first:
            m.wait_prompt(300 * run.factor)
        m.qmp.type_text(flow.PASSPHRASE + "\n", layout=layout)
        m.serial.wait_for_shell(300 * run.factor, via_grub=True)

    return run.check(f"criterion 2: Plymouth prompt unlocks the disk (typed on the {layout} layout)", right)


def greeter_login(run: Run, m: Machine, layout: str = "us") -> None:
    sh = run.sh

    def wrong_password():
        time.sleep(5)
        m.screen("greeter")
        m.qmp.type_text(flow.WRONG_PASSWORD + "\n", layout=layout)
        time.sleep(8)
        status, _ = m.serial.run(f"loginctl list-users --no-legend | grep -qw {flow.USER}")
        assert status != 0, "a wrong password opened a session"

    run.check("criterion 6: wrong password opens no session", wrong_password)

    def login():
        start = time.monotonic()
        m.qmp.type_text(flow.PASSWORD + "\n", layout=layout)
        sh(f"for i in $(seq 120); do pgrep -u {flow.USER} -x labwc >/dev/null && exit 0; sleep 1; done; exit 1", 130)
        uid = int(sh(f"id -u {flow.USER}").strip())
        sh(scenarios.mount_assets())
        sh(scenarios.jarvisctl(uid, "wait --timeout 120", user=flow.USER), 130)
        seconds = time.monotonic() - start
        if seconds > 10 and os.environ.get("GITHUB_ACTIONS"):
            print(f"::warning::jarvisd ready {seconds:.0f}s after login (target 10 s on reference hardware)", flush=True)
        assert seconds <= 60 * run.factor, f"jarvisd not ready {seconds:.0f}s after login"
        return f"jarvisd ready {seconds:.1f}s after login"

    run.check("criterion 6: greeter login → labwc → jarvisd ready", login)


def scenario_erase(args, run: Run, work: Path, out: Path, ovmf: firmware.Ovmf) -> None:
    b = brand(BRAND_ENV)
    target = disks.make_blank(work / "target.img", 40)
    vars_path = firmware.make_vars(ovmf, work / "vars.fd")
    assets = build_assets(work)
    before = disks.sparse_digest(target)
    with Machine("live", live_vm(args, work, (target,), vars_path, ovmf, assets, "live"), out) as m:
        run.shell = m.serial
        if not live_session(run, m):
            return
        ok = install(run, flow.choices("/dev/vda", "erase", keyboard=ERASE_KEYBOARD), target, before)
        run.check("criterion 2: root is LUKS2", lambda: run.sh(flow.luks2_on("/dev/vda")))
        run.check("secrets never in the live journal", lambda: run.sh(
            f"! journalctl -b --no-pager | grep -qF -e '{flow.PASSPHRASE}' -e '{flow.PASSWORD}'"))
        m.poweroff()
    if not ok:
        return
    vm = qemu.InstallVm(disks=(target,), assets=assets, serial_socket=work / "s-t.sock",
                        qmp_socket=work / "q-t.sock", ovmf=ovmf, vars_path=vars_path, accel=args.accel)
    with Machine("target", vm, out) as m:
        run.shell = m.serial
        if not unlock(run, m, wrong_first=True, layout=ERASE_KEYBOARD):
            return
        for name, command in target_checks(b) + boot_checks():
            run.check(name, lambda c=command: run.sh(c, 200))
        run.check("GRUB menu hidden with no other OS (design §7)", lambda: run.sh("! grep -qx 'set timeout=3' /boot/grub/grub.cfg"))
        kb = keyboard_checks(ERASE_KEYBOARD)
        for name, command in kb[:3]:
            run.check(name, lambda c=command: run.sh(c, 120))
        greeter_login(run, m, ERASE_KEYBOARD)
        for name, command in kb[3:]:
            run.check(name, lambda c=command: run.sh(c, 60))
        if args.update_repo:
            import updates  # Task 17; imported lazily so Task 16 stands alone

            updates.run_updates(run, m, args.update_repo)
        m.poweroff()


def scenario_alongside(args, run: Run, work: Path, out: Path, ovmf: firmware.Ovmf) -> None:
    b = brand(BRAND_ENV)
    win = disks.make_windows_disk(work / "win.img", 64, "clean")
    ntfs_before = {p.number: p for p in disks.partitions(win)}[3]
    vars_path = firmware.make_vars(ovmf, work / "vars.fd")
    assets = build_assets(work)
    # At least MinRootBytes (30 GiB) + the 1 GiB unencrypted /boot of an
    # encrypted install (contracts §12); Windows' ESP is reused.
    given = 32 * GIB
    with Machine("live", live_vm(args, work, (win,), vars_path, ovmf, assets, "live"), out) as m:
        run.shell = m.serial
        if not live_session(run, m):
            return
        ok = install(run, flow.choices("/dev/vda", "alongside", alongside_bytes=given), win, disks.sparse_digest(win))
        m.poweroff()
    if not ok:
        return

    def windows_intact():
        after = {p.number: p for p in disks.partitions(win)}[3]
        assert shrunk_ok(ntfs_before, after, given), f"NTFS {ntfs_before} -> {after}"
        assert disks.inspect_windows(win) == {"ntfsfix": "ok", "bootmgfw": "yes"}, disks.inspect_windows(win)

    run.check("criterion 3: NTFS shrunk in place, ntfsfix --no-action clean, Boot Manager kept", windows_intact)
    vm = qemu.InstallVm(disks=(win,), assets=assets, serial_socket=work / "s-t.sock",
                        qmp_socket=work / "q-t.sock", ovmf=ovmf, vars_path=vars_path, accel=args.accel)
    with Machine("target", vm, out) as m:
        run.shell = m.serial
        if not unlock(run, m, wrong_first=False):
            return
        run.check("criterion 1: Secure Boot still enabled", lambda: run.sh("mokutil --sb-state | grep -qx 'SecureBoot enabled'"))
        run.check("criterion 2: root is on the unlocked LUKS device", lambda: run.sh("findmnt -no SOURCE / | grep -q '^/dev/mapper/'"))
        for name, command in boot_checks():
            run.check(name, lambda c=command: run.sh(c, 120))
        run.check("criterion 3: GRUB lists Windows and the brand, 3 s menu", lambda: run.sh(
            "grep -q \"menuentry 'Windows Boot Manager\" /boot/grub/grub.cfg && "
            f"grep -q \"menuentry '{b['DISTRO_NAME']}\" /boot/grub/grub.cfg && grep -qx 'set timeout=3' /boot/grub/grub.cfg"))
        m.poweroff()


def scenario_refusals(args, run: Run, work: Path, out: Path, ovmf: firmware.Ovmf) -> None:
    images = [disks.make_windows_disk(work / f"{state}.img", 48, state) for state in REFUSALS]
    digests = {p: disks.sparse_digest(p) for p in images}
    vars_path = firmware.make_vars(ovmf, work / "vars.fd")
    assets = build_assets(work)

    def refused(disk: str, reason: str):
        def check():
            status, text = run.shell.run(flow.plan(flow.choices(disk, "alongside", alongside_bytes=24 * GIB)), 120 * run.factor)
            assert status == 3 and f'"refused":"{reason}"' in text, f"exit {status}: {text[-800:]}"
        return check

    with Machine("live", live_vm(args, work, tuple(images), vars_path, ovmf, assets, "live"), out) as m:
        run.shell = m.serial
        if not live_session(run, m):
            return
        for i, (state, reason) in enumerate(REFUSALS.items()):
            run.check(f"criterion 4: {state} Windows refused ({reason})", refused(f"/dev/vd{chr(ord('a') + i)}", reason))
        run.check("criterion 5: an erase Plan on the same disk is only a plan", lambda: run.sh(flow.plan(flow.choices("/dev/vda", "erase")), 120))
        m.poweroff()

    def unchanged():
        changed = [p.name for p, d in digests.items() if disks.sparse_digest(p) != d]
        assert not changed, f"changed: {changed}"

    run.check("criteria 4-5: no disk changed", unchanged)


def scenario_local_model(args, run: Run, work: Path, out: Path, ovmf: firmware.Ovmf) -> None:
    """Criterion 7: an offline install (no NIC) of a local model; first boot,
    online, fetches it (jarvis-model-fetch) before and after login."""
    target = disks.make_blank(work / "target.img", 48)
    vars_path = firmware.make_vars(ovmf, work / "vars.fd")
    assets = build_assets(work)
    before = disks.sparse_digest(target)
    live = live_vm(args, work, (target,), vars_path, ovmf, assets, "live", memory_mb=LOCAL_MODEL_RAM_MB, network=False)
    with Machine("live", live, out) as m:
        run.shell = m.serial
        if not live_session(run, m):
            return
        run.check("criterion 7: Probe is offline and the local model fits", lambda: run.sh(
            flow.probe() + " | grep -q '\"online\":false'"))
        ok = install(run, flow.choices("/dev/vda", "erase", brain=flow.local_brain()), target, before)
        m.poweroff()
    if not ok:
        return
    vm = qemu.InstallVm(disks=(target,), assets=assets, serial_socket=work / "s-t.sock", qmp_socket=work / "q-t.sock",
                        ovmf=ovmf, vars_path=vars_path, accel=args.accel, memory_mb=LOCAL_MODEL_RAM_MB)
    with Machine("target", vm, out) as m:
        run.shell = m.serial
        if not unlock(run, m, wrong_first=False):
            return
        for name, command in boot_checks():
            run.check(name, lambda c=command: run.sh(c, 120))
        checks = model_checks(flow.USER)
        for name, command in checks[:2]:
            run.check(name, lambda c=command: run.sh(c, 1900))
        greeter_login(run, m)
        for name, command in checks[2:]:
            run.check(name, lambda c=command: run.sh(c, 120))
        m.poweroff()


SCENARIOS = {"erase": scenario_erase, "alongside": scenario_alongside, "refusals": scenario_refusals,
             "local-model": scenario_local_model}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--iso", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--scenario", required=True, choices=sorted(SCENARIOS))
    p.add_argument("--accel", choices=["auto", "kvm", "tcg"], default="auto")
    p.add_argument("--allow-tcg", action="store_true", help="hours; for debugging only")
    p.add_argument("--work", type=Path, help="where the disk images go (sparse, up to 64 GiB apparent)")
    p.add_argument("--ovmf-code", type=Path)
    p.add_argument("--ovmf-vars", type=Path)
    p.add_argument("--update-repo", type=Path, help="Task 17: site dir with good/ and rogue/ repos (erase only)")
    args = p.parse_args(argv)
    args.accel = qemu.detect_accel() if args.accel == "auto" else args.accel
    if args.accel != "kvm" and not args.allow_tcg:
        print("run_install: install tests need KVM (pass --allow-tcg to try TCG anyway)", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    ovmf = firmware.find_ovmf(args.ovmf_code, args.ovmf_vars)
    run = Run(None, 1 if args.accel == "kvm" else 6)
    work = Path(tempfile.mkdtemp(prefix="jinst-", dir=args.work))
    try:
        SCENARIOS[args.scenario](args, run, work, args.out, ovmf)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    summary = report.render_summary(run.results, None, args.accel, title=f"Install test: {args.scenario}")
    (args.out / "summary.md").write_text(summary)
    (args.out / "results.json").write_text(json.dumps({"accel": args.accel, "results": run.results}, indent=2))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary)
    print(summary)
    return 0 if run.results and all(r["ok"] for r in run.results) else 1


if __name__ == "__main__":
    sys.exit(main())
