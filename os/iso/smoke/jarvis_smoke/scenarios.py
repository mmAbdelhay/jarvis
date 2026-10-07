"""Guest command lines for the smoke checks. Every function returns ONE shell
line for SerialShell.run (POSIX sh, run as root in the debug shell)."""

from __future__ import annotations

USER = "jarvis"
NODE = "/usr/lib/jarvis/node/bin/node"
ASSETS = "/run/jarvis-smoke"
CONNECTIVITY_CONF = "/etc/NetworkManager/conf.d/99-smoke-connectivity.conf"
REQUIRED_GROUPS = ("systemd-journal", "netdev", "sudo", "jarvis-admins")
DPKG_HELLO_INSTALLED = "dpkg -l hello | grep -Eq '^ii +hello '"
# The root helper was started by D-Bus activation at least once this boot.
HELPER_WAS_ACTIVATED = (
    "[ \"$(systemctl show -p ActiveEnterTimestampMonotonic --value jarvis-helper.service)\" != 0 ]"
)
# apt-get, run as root by the helper, recorded installing hello.
APT_HISTORY_HELLO = "grep -Eq '^Commandline: .*apt-get install .*hello' /var/log/apt/history.log"


def as_user(uid: int, command: str) -> str:
    return (
        f"runuser -u {USER} -- env HOME=/home/{USER} XDG_RUNTIME_DIR=/run/user/{uid} "
        f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus {command}"
    )


def jarvisctl(uid: int, args: str) -> str:
    return as_user(uid, f"{NODE} {ASSETS}/jarvisctl.mjs {args}")


def use_fake_provider(uid: int, script: str | None) -> str:
    """Sets (or clears) JARVIS_FAKE_PROVIDER in jarvis's user manager only,
    restarts jarvisd and waits for it. Nothing is written to disk."""
    if script is None:
        env = "systemctl --user unset-environment JARVIS_FAKE_PROVIDER"
    else:
        env = f"systemctl --user set-environment JARVIS_FAKE_PROVIDER={ASSETS}/scripts/{script}"
    return " && ".join(
        [as_user(uid, env), as_user(uid, "systemctl --user restart jarvisd.service"),
         jarvisctl(uid, "wait --timeout 90")]
    )


def wait_for_session(seconds: int) -> str:
    """Criterion 1: labwc and jarvis-shell run as the autologin user."""
    return (
        f"for i in $(seq {seconds}); do "
        f"pgrep -u {USER} -x labwc >/dev/null && pgrep -u {USER} -x jarvis-shell >/dev/null && exit 0; "
        f"sleep 2; done; ps -eo user,pid,comm | grep -v ' \\[' ; exit 1"
    )


def wait_for_socket(seconds: int) -> str:
    return (
        f"for i in $(seq {seconds}); do test -S /home/{USER}/.config/jarvis/run/jarvisd.sock && exit 0; "
        f"sleep 1; done; exit 1"
    )


def polkit_grants(uid: int, action: str) -> str:
    """polkit authorizes ACTION for jarvisd's process, which runs in the user
    manager outside any logind session, like the MCP servers it starts
    (contracts §6 #19: the 50-jarvis.rules grant to jarvis-admins)."""
    pid = as_user(uid, "systemctl --user show -p MainPID --value jarvisd.service")
    return f'pid=$({pid}) && [ "$pid" -gt 0 ] && pkcheck --action-id {action} --process "$pid"'


def shell_relaunches(seconds: int) -> str:
    """Kills jarvis-shell; the autostart loop must start a new one (design §10)."""
    return (
        f"old=$(pgrep -u {USER} -x jarvis-shell | head -n1) && [ -n \"$old\" ] && kill \"$old\" && "
        f"for i in $(seq {seconds}); do sleep 1; new=$(pgrep -u {USER} -x jarvis-shell | head -n1); "
        f"[ -n \"$new\" ] && [ \"$new\" != \"$old\" ] && exit 0; done; exit 1"
    )


def mount_assets() -> str:
    return f"mkdir -p {ASSETS} && (mountpoint -q {ASSETS} || mount -o ro -L JARVISSMOKE {ASSETS})"


def connectivity_setup(port: int) -> str:
    """Points NetworkManager's connectivity check at the harness's host endpoint.
    /etc is the live session's tmpfs overlay: nothing outlives this boot."""
    return (
        f"printf '[connectivity]\\nuri=http://10.0.2.2:{port}/nm\\n"
        f"response=NetworkManager is online\\ninterval=10\\n' > {CONNECTIVITY_CONF} "
        f"&& systemctl restart NetworkManager"
    )


def wait_connectivity_full(seconds: int) -> str:
    return (
        f"for i in $(seq {seconds}); do "
        f"[ \"$(nmcli networking connectivity check 2>/dev/null)\" = full ] && exit 0; sleep 1; done; "
        f"nmcli networking connectivity check; exit 1"
    )
