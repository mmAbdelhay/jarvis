"""Guest command lines and host helpers for the computer-use KVM test
(v1.1 design §2). Every command builder returns ONE shell line for
SerialShell.run (POSIX sh, run as root in the debug shell)."""

from __future__ import annotations

import re
from pathlib import Path

from jarvis_smoke import scenarios

CU = f"{scenarios.ASSETS}/cu"
LOGS = "/run/jarvis-cu-test"
REPORT = f"{LOGS}/fakevision-report.json"
HOME = f"/home/{scenarios.USER}"
PORT = 11500
PNG_TARGET = f"{HOME}/Pictures/beach.png"
INSTALL_GIMP = (
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends gimp >/dev/null"
)
AUDIT = f"{HOME}/.local/state/jarvis/audit.jsonl"
AUDIT_HAS_GOAL = f"grep -qF beach.xcf {AUDIT}"
AUDIT_HAS_ACTIONS = f"grep -qE '\"tool\":\"screen[._](click|key|type)' {AUDIT}"
AUDIT_HAS_GOAL_AND_ACTIONS = f"{AUDIT_HAS_GOAL} && {AUDIT_HAS_ACTIONS}"


def log(name: str) -> str:
    return f"{LOGS}/turn-{name}.log"


def wait(command: str, seconds: int) -> str:
    return f"for i in $(seq {seconds}); do {command} && exit 0; sleep 1; done; exit 1"


def display(uid: int) -> str:
    return f"$(cd /run/user/{uid} && ls wayland-* | grep -v '[.]lock$' | head -n1)"


def prepare_logs() -> str:
    return f"install -d -o {scenarios.USER} -m0755 {LOGS}"


def helper_active(uid: int) -> str:
    return scenarios.as_user(uid, "systemctl --user is-active --quiet jarvis-cu.service")


def socket_private(uid: int) -> str:
    return f'[ "$(stat -c %a /run/user/{uid}/jarvis/cu.sock)" = 600 ]'


def peer_probe(uid: int, jarvisd_argv: bool = False) -> str:
    """Review Focus 3: a same-user Node process that is not jarvisd."""
    sock = f"/run/user/{uid}/jarvis/cu.sock"
    if jarvisd_argv:
        probe = f"--import file://{CU}/peer-probe.mjs /usr/lib/jarvis/daemon/jarvisd.mjs run"
    else:
        probe = f"{CU}/peer-probe.mjs"
    return f'[ "$({scenarios.as_user(uid, f"env CU_SOCK={sock} {scenarios.NODE} {probe}")})" = REFUSED ]'


def start_fakevision(uid: int) -> str:
    app = "$(basename \"$(ls /usr/share/applications/*gimp*.desktop | head -n1)\" .desktop)"
    run = (f"env GIMP_APP={app} setsid -f {scenarios.NODE} {CU}/fakevision.mjs --script {CU}/cu-gimp.json "
           f"--report {REPORT} --port {PORT}")
    return f"{scenarios.as_user(uid, run)} > {LOGS}/fakevision.log 2>&1 && " + wait(
        f"ss -Hltn | grep -q '127.0.0.1:{PORT} '", 30)


def use_scripted_provider(uid: int) -> str:
    return " && ".join([
        scenarios.as_user(uid, f"mkdir -p {HOME}/.config/jarvis"),
        scenarios.as_user(uid, f"install -m0600 {CU}/jarvis.yaml {HOME}/.config/jarvis/jarvis.yaml"),
        scenarios.as_user(uid, "systemctl --user unset-environment JARVIS_FAKE_PROVIDER"),
        scenarios.as_user(uid, "systemctl --user restart jarvisd.service"),
        scenarios.jarvisctl(uid, "wait --timeout 90"),
    ])


def make_fixture(uid: int) -> str:
    return scenarios.as_user(uid, f"sh {CU}/make-fixture.sh {HOME}") + f" && head -c 9 {HOME}/beach.xcf | grep -q 'gimp xcf'"


def start_gimp(uid: int) -> str:
    return " && ".join([
        scenarios.as_user(uid, f"mkdir -p {HOME}/.config/GIMP/3.0 {HOME}/Pictures"),
        scenarios.as_user(uid, f"sh {CU}/install-gimprc.sh {HOME}/.config/GIMP/3.0"),
        scenarios.as_user(uid, f"env WAYLAND_DISPLAY={display(uid)} setsid -f gimp -n --no-splash {HOME}/beach.xcf")
        + f" > {LOGS}/gimp.log 2>&1",
        wait(f"pgrep -u {scenarios.USER} -f gimp-3 >/dev/null", 90),
    ])


def turn(uid: int, name: str, text: str, flags: str = "", background: bool = False) -> str:
    if "'" in text:
        raise ValueError("turn text must not contain single quotes")
    command = scenarios.jarvisctl(uid, f"cu --text '{text}' --timeout 600 {flags}".rstrip()) + f" > {log(name)} 2>&1"
    return f"setsid -f {command}" if background else f"{command} || true"


def enable(uid: int) -> str:
    return scenarios.jarvisctl(uid, "cu-enable --provider scripted")


def stop(uid: int) -> str:
    return scenarios.jarvisctl(uid, "cu-stop")


def cucheck(uid: int, args: str) -> str:
    return scenarios.as_user(uid, f"{scenarios.NODE} {CU}/cucheck.mjs {args}")


def wait_check(uid: int, args: str, seconds: int) -> str:
    """Retries a cucheck twice a second; the last try prints its reasons."""
    check = cucheck(uid, args)
    return f"for i in $(seq {seconds * 2}); do {check} 2>/dev/null && exit 0; sleep 0.5; done; {check}"


def no_screenshots_stored(uid: int) -> str:
    """Criterion 8: no screenshot on disk or in a log. The base64 PNG marker must be in no
    file of jarvis's directories, /tmp or the test logs, and in neither service journal."""
    own = (f"{HOME}/.local/state/jarvis {HOME}/.local/share/jarvis {HOME}/.config/jarvis {HOME}/.cache/jarvis "
           f"/run/user/{uid}/jarvis")
    dirs = f"{own} /tmp {LOGS}"
    journal = scenarios.as_user(uid, "journalctl --user -u jarvisd -u jarvis-cu --no-pager")
    return (f"! (find {dirs} -type f 2>/dev/null | xargs -r grep -l -a -e iVBORw0KGgo -- 2>/dev/null | grep -q .) "
            f"&& [ -z \"$(find {own} -name '*.png' 2>/dev/null)\" ] "
            f"&& ! ({journal} | grep -q iVBORw0KGgo)")


_PPM = re.compile(rb"P6\s+(\d+)\s+(\d+)\s+(\d+)\s")


def read_ppm(path: Path) -> tuple[int, int, bytes]:
    """QMP screendump output (binary PPM, 8 bit)."""
    data = Path(path).read_bytes()
    m = _PPM.match(data)
    if m is None or int(m.group(3)) != 255:
        raise ValueError(f"{path} is not an 8-bit binary PPM")
    w, h = int(m.group(1)), int(m.group(2))
    pixels = data[m.end(): m.end() + w * h * 3]
    if len(pixels) != w * h * 3:
        raise ValueError(f"{path}: short pixel data")
    return w, h, pixels


def is_teal(r: int, g: int, b: int) -> bool:
    return g >= 110 and b >= 100 and r <= 110 and g - r >= 50


def frame_teal_ratio(w: int, h: int, pixels: bytes, band: int = 4) -> float:
    """Share of the outermost `band` pixels that are teal (criterion 3, gap G13)."""
    hit = total = 0
    for y in range(h):
        xs = range(w) if y < band or y >= h - band else [*range(band), *range(w - band, w)]
        for x in xs:
            o = (y * w + x) * 3
            total += 1
            hit += is_teal(pixels[o], pixels[o + 1], pixels[o + 2])
    return hit / total if total else 0.0
