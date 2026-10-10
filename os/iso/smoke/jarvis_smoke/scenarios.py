"""Guest command lines for the smoke checks. Every function returns ONE shell
line for SerialShell.run (POSIX sh, run as root in the debug shell)."""

from __future__ import annotations

USER = "jarvis"
NODE = "/usr/lib/jarvis/node/bin/node"
ASSETS = "/run/jarvis-smoke"
CONNECTIVITY_CONF = "/etc/NetworkManager/conf.d/99-smoke-connectivity.conf"
REQUIRED_GROUPS = ("systemd-journal", "netdev", "sudo", "jarvis-admins", "bluetooth")
DPKG_HELLO_INSTALLED = "dpkg -l hello | grep -Eq '^ii +hello '"
# The root helper was started by D-Bus activation at least once this boot.
HELPER_WAS_ACTIVATED = (
    "[ \"$(systemctl show -p ActiveEnterTimestampMonotonic --value jarvis-helper.service)\" != 0 ]"
)
# apt-get, run as root by the helper, recorded installing hello.
# The doctor (via "doctor" in the audit log) restarted NetworkManager.
DOCTOR_RESTARTED_NM = (
    "grep -F '\"via\":\"doctor\"' /home/jarvis/.local/state/jarvis/audit.jsonl"
    " | grep -F '\"unit\":\"NetworkManager\"' | grep -qF '\"result\":\"ok\"'"
)
APT_HISTORY_HELLO = "grep -Eq '^Commandline: .*apt-get install .*hello' /var/log/apt/history.log"


def as_user(uid: int, command: str, user: str = USER) -> str:
    return (
        f"runuser -u {user} -- env HOME=/home/{user} XDG_RUNTIME_DIR=/run/user/{uid} "
        f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus {command}"
    )


def jarvisctl(uid: int, args: str, user: str = USER) -> str:
    return as_user(uid, f"{NODE} {ASSETS}/jarvisctl.mjs {args}", user)


def use_fake_provider(uid: int, script: str | None, user: str = USER) -> str:
    """Sets (or clears) JARVIS_FAKE_PROVIDER in jarvis's user manager only,
    restarts jarvisd and waits for it. Nothing is written to disk."""
    if script is None:
        env = "systemctl --user unset-environment JARVIS_FAKE_PROVIDER"
    else:
        env = f"systemctl --user set-environment JARVIS_FAKE_PROVIDER={ASSETS}/scripts/{script}"
    return " && ".join(
        [as_user(uid, env, user), as_user(uid, "systemctl --user restart jarvisd.service", user),
         jarvisctl(uid, "wait --timeout 90", user)]
    )


def wait_for_user(seconds: int) -> str:
    """The serial debug shell comes up before live-config has created the
    live user, so wait for it before anything asks for its uid."""
    return f"for i in $(seq {seconds}); do id -u {USER} >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1"


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


# The live overlay only: nothing outlives the boot. Used when the ISO's
# keyring cannot verify the public repo (throwaway key, or no Pages repo yet).
DISABLE_JARVIS_APT = "mv /etc/apt/sources.list.d/jarvis.sources /run/jarvis.sources.disabled"


# --- Rafiq M3 (Plan P) ---
# Session-level actions 51-jarvis-settings.rules grants to jarvisd's tools
# (the subset whose polkit policy exists on trixie). power-profiles-daemon 0.30
# registers only org.freedesktop.UPower.PowerProfiles.*; the rule keeps the
# legacy net.hadess id for older daemons, but pkcheck refuses unregistered ids.
SETTINGS_ACTIONS = (
    "org.freedesktop.NetworkManager.enable-disable-wifi",
    "org.freedesktop.UPower.PowerProfiles.switch-profile",
    "org.freedesktop.udisks2.filesystem-mount",
)
SETTINGS_RULE_LACKS_ADMIN = "! grep -q 'helper[.]admin' /usr/share/polkit-1/rules.d/51-jarvis-settings.rules"
# Live boots never idle-lock (jarvis-idle's autostart fragment); the fragment is installed.
NO_IDLE_ON_LIVE = (
    f"test -f /usr/share/jarvis-idle/labwc/autostart && ! pgrep -u {USER} -f jarvis-idle-loop >/dev/null"
)
# Engines at /usr/lib/jarvis/voice/bin (contracts §5 #13), models + manifest.
VOICE_INSTALLED = (
    "test -x /usr/lib/jarvis/voice/bin/whisper-cli && test -x /usr/lib/jarvis/voice/bin/piper"
    " && test -s /usr/share/jarvis/voice/manifest.json"
)
# Phone bridge is off by default (remote.enabled): nothing listens beyond loopback.
NO_LAN_LISTENER = (
    "! ss -Hltn | awk '{print $4}' | grep -Ev '^(127\\.[0-9.]+|\\[::1\\]|::1):[0-9]+$'"
)
# The lock screen checks the live user's password (live-config sets one).
LIVE_PASSWORD_SET = f"[ \"$(passwd -S {USER} | awk '{{print $2}}')\" = P ]"


def user_env_has(uid: int, name: str) -> str:
    """labwc's autostart imported NAME into the user manager (Task 8)."""
    return as_user(uid, "systemctl --user show-environment") + f" | grep -q '^{name}='"


def process_runs(name: str) -> str:
    return f"pgrep -u {USER} -x {name} >/dev/null"


def polkit_denies(uid: int, action: str) -> str:
    """Like polkit_grants, but the action must NOT be authorized for jarvisd."""
    pid = as_user(uid, "systemctl --user show -p MainPID --value jarvisd.service")
    return f'pid=$({pid}) && [ "$pid" -gt 0 ] && ! pkcheck --action-id {action} --process "$pid"'


def start_lock(uid: int) -> str:
    """Starts jarvis-lock in the live session, as Super+L does (contracts §3)."""
    display = f"$(cd /run/user/{uid} && ls wayland-* | grep -v '[.]lock$' | head -n1)"
    return (
        as_user(uid, f"env WAYLAND_DISPLAY={display} QT_QPA_PLATFORM=wayland setsid -f jarvis-lock")
        + f" && sleep 3 && pgrep -u {USER} -x jarvis-lock >/dev/null"
    )


# --- Rafiq v1.1 fixes ---
def keyring_roundtrip(uid: int, user: str = USER) -> str:
    """Stores a Secret Service item in the default collection and reads it
    back as USER, each step bounded: a "Choose password for new keyring" or
    unlock prompt makes secret-tool wait, so a timeout here is that prompt.
    No prompter may be up afterwards. The item is removed again."""
    tool = as_user(uid, "timeout 15 secret-tool", user)
    attrs = "service jarvis-smoke account keyring-probe"
    return (
        f"printf smoke-secret | {tool} store --label=jarvis-smoke {attrs} && "
        f"[ \"$({tool} lookup {attrs})\" = smoke-secret ] && "
        f"{tool} clear {attrs} && "
        f"! pgrep -u {user} -f gcr-prompter >/dev/null && "
        f"test -s /home/{user}/.local/share/keyrings/login.keyring"
    )


def login_keyring_encrypted(user: str = USER) -> str:
    """Installed systems: pam_gnome_keyring made the login keyring with the
    login password, so it is in the encrypted binary format, not plain text."""
    path = f"/home/{user}/.local/share/keyrings/login.keyring"
    return f"[ \"$(head -c 12 {path})\" = GnomeKeyring ] && ! grep -q '^\\[keyring\\]' {path}"

