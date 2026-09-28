# Background daemon

Jarvis can keep running after you quit its window. The part that does the
work moves into a background process, `jarvisd`. That part is the terminals,
the agent runs, the remote bridge and the browser client. The app becomes a
window onto it: quit the app and your terminals and agent runs keep going,
and a paired phone or browser can still reach this machine. Open the app
again and it shows the same tabs and the same terminals.

This is off by default. With it off, Jarvis works as it always has: the
work runs inside the app and stops when the app quits.

## Turning it on

**Settings → General → Keep Jarvis running in the background.**

- **Turning it on** asks first, because open terminals in this window close,
  and so do running agents. Jarvis then registers `jarvisd` with the
  operating system's service manager, starts it, and moves the window over
  to it. Terminals you open from then on live in the daemon.
- **Turning it off** also asks first. The terminals running in the
  background close. Jarvis stops the daemon, removes its service
  registration, and restarts inside the app.
- **Restart daemon** restarts it through the service manager. The window
  reconnects on its own.
- **Stop now (this session only)** stops the daemon and runs Jarvis inside
  the app until it restarts. The setting stays on, so the next login, or the
  next time you open Jarvis, starts the daemon again.

The status line under the toggle shows the daemon's pid and uptime. If the
daemon failed, it shows the reason and the last line of its log.

When the setting is on and the app starts but cannot reach the daemon, it
tries to start it and waits up to 10 seconds. If that fails, it asks you
whether to **Run inside the app this time** or **Quit**. Running inside the
app leaves the setting on.

When the setting is off but a daemon is already running, for example one
you started with `jarvisd run`, the app does not start a second copy of the
work beside it. It attaches to that daemon for this session instead, and
the status line says **Attached to a jarvisd that was already running**.
The setting stays off. **Stop now** stops that daemon and restarts Jarvis
inside the app. **Restart daemon** is refused, because the service manager
did not start that daemon. Turning the setting on while attached registers
the service and leaves the running daemon as it is. If the running daemon
can't be attached, because it is from another build, the app asks whether to
stop it and **Run inside the app this time**, or **Quit**.

Jarvis runs one window per user. Opening it again, from the Dock, a launcher
or a shortcut, brings the open window forward instead of starting a second
copy.

The setting is `daemon.enabled` in `jarvis.yaml` (see
the `daemon:` section of [configuration](configuration.md)). Change it
from Settings rather than by hand: the toggle is what installs and removes
the service.

## The `jarvisd` command

`jarvisd` is the daemon's command line. It talks to a running daemon over
its local control socket, which lets you administer Jarvis on a machine with
no screen, for example a server you reach over SSH.

| Command | What it does |
|---|---|
| `jarvisd run` | Runs the daemon in the foreground, in this terminal. |
| `jarvisd status` | Shows whether the daemon runs, and the remote access state: bridge on or off, owner password, passkeys, browser access, paired devices, pairing. |
| `jarvisd set-password` | Sets or changes the owner password. It asks without echo: the current password (if one is set), the new one, then the new one again. |
| `jarvisd set-password --stdin` | Reads the password from standard input instead: one line, or two lines (current, then new) when a password is already set. |
| `jarvisd pair` | Opens pairing and prints the instructions, a QR code, the `jarvis://` link and, with browser access on, the web pairing link. Then it waits for a device and asks `Approve? [y/N]`. Ctrl-C cancels. |
| `jarvisd devices` | Lists paired devices. |
| `jarvisd revoke <id>` | Unpairs a device. Its sign-ins end. |
| `jarvisd sign-out-all [--yes]` | Signs every phone and browser out. It asks first unless you pass `--yes`. |
| `jarvisd web on` / `jarvisd web off` | Turns browser access on or off. |
| `jarvisd stop` | Stops the daemon and waits for it to exit. It works on a daemon of any build, so it also stops an old daemon after an update. |
| `jarvisd --help` | Shows this list. |

`set-password` refuses to read a password from a pipe unless you pass
`--stdin`, and refuses `--stdin` when standard input is a terminal, where the
password would show as you type. `pair` prints the pairing link and QR code
only to a terminal.

In a hidden prompt, keys that send escape sequences, such as the arrow
keys, Home, End and Delete, add nothing to the password.

Prompts go to standard error, so standard output carries only the answer.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Done. |
| `1` | Failed: the daemon refused, the connection dropped, you answered no, or the daemon runs a different build. |
| `2` | Usage error, `set-password` from a pipe without `--stdin`, or `set-password --stdin` from a terminal. |
| `3` | The daemon is not running. For `jarvisd run`: another daemon already is. When launchd or systemd starts the daemon and another one already runs, it exits `0` instead, so the service manager does not keep starting it again. |

### Running `jarvisd`

There is no separate Node to install. The app binary runs the CLI script
itself when `ELECTRON_RUN_AS_NODE=1` is set. Each packaged app ships a
launcher that does this for you:

| OS | Launcher |
|---|---|
| macOS | `/Applications/Jarvis.app/Contents/Resources/bin/jarvisd` |
| Linux | `resources/bin/jarvisd`, in the unpacked app directory |
| Windows | `resources\bin\jarvisd.cmd`, in the folder you unpacked Jarvis to |

Jarvis never changes your `PATH`. To type `jarvisd` anywhere, link the
launcher into a directory that is already on your `PATH`, or add its
directory to `PATH` yourself.

On macOS or Linux, a symlink works, and the launcher follows it back to the
app:

```sh
ln -s /Applications/Jarvis.app/Contents/Resources/bin/jarvisd ~/.local/bin/jarvisd
```

On Windows, add the `resources\bin` folder to your user `PATH` in
**Settings → System → About → Advanced system settings → Environment
Variables**.

The launcher runs this, which you can also type directly:

```sh
# macOS (Linux: the binary is <app dir>/jarvis and the script is under <app dir>/resources)
ELECTRON_RUN_AS_NODE=1 /Applications/Jarvis.app/Contents/MacOS/Jarvis \
  /Applications/Jarvis.app/Contents/Resources/app.asar/dist/src/daemon/cli/jarvisd.js status
```

On Windows, run the launcher itself rather than setting
`ELECTRON_RUN_AS_NODE` in your console. Set there, it stays set for every
program you start from that console, and any Electron app among them, Jarvis
included, would start as plain Node and fail:

```bat
rem Windows
"C:\path\to\Jarvis\resources\bin\jarvisd.cmd" status
```

From a source checkout, after `pnpm build`:

```sh
node packages/desktop/dist/src/daemon/cli/jarvisd.js status
```

## What it creates, per OS

On every OS the daemon uses one run directory, `~/.config/jarvis/run` (on
Windows `%USERPROFILE%\.config\jarvis\run`):

| File | What it is |
|---|---|
| `jarvisd.sock` | The control socket (macOS and Linux). Mode 0600. |
| `control.secret` | A random 32-byte secret, as hex, new at every daemon start. Only a process that can read it can use the control socket. Mode 0600. |
| `control.endpoint` | Windows only: the name of the control pipe, `\\.\pipe\jarvisd-` plus 16 random hex characters, new at every start. |
| `jarvisd.pid` | The single-instance lock: the daemon's pid and a random token. |

On macOS and Linux the directory must be owned by you, have mode 0700, and
not be a symlink, or the daemon refuses to start.

The daemon's log is `~/.config/jarvis/logs/jarvisd.log`, mode 0600. It
rotates to `jarvisd.log.1` at 5 MiB. Secrets such as tokens and passwords
are masked before a line is written.

The service registration depends on the OS.

### macOS

A LaunchAgent at `~/Library/LaunchAgents/dev.jarvis.daemon.plist`, label
`dev.jarvis.daemon`, loaded into your login session (`gui/<uid>`). It starts
at login, and launchd starts it again if it exits with an error. Its
standard output and error go to `~/.config/jarvis/logs/jarvisd.out.log` and
`jarvisd.err.log`.

The plist names the app's binary by its full path. If you move the app
later, the next time you open it Jarvis sees that the plist names another
copy and registers the service again from the new place. That restarts the
daemon, so terminals running in the background close.

Move Jarvis to `/Applications` before turning the setting on. An app run
straight from Downloads or from the disk image runs from a temporary
location that macOS can change, and each change means another
re-registration.

### Linux

A systemd user unit at `~/.config/systemd/user/jarvisd.service`, enabled for
`default.target` with `Restart=on-failure`. Read its output with
`journalctl --user -u jarvisd`.

The unit sets `RestartPreventExitStatus=3`, so a daemon that finds another
one already running is not started again every few seconds. It also sets
`KillMode=process`: stopping or restarting the daemon closes its terminals,
but a program you detached from one of them, such as a `tmux` server, a
`nohup` job or `docker compose`, keeps running, as it does when you quit the
app with the setting off.

A user unit runs only while you are logged in. On a headless server, where
you want the daemon running with nobody logged in, enable lingering for
your user once. This needs sudo, so Jarvis does not do it for you:

```sh
sudo loginctl enable-linger "$USER"
```

The unit names the app by its full path. For an AppImage it names the
`.AppImage` file itself, with `--jarvis-daemon`, because the AppImage's
contents are mounted at a temporary path that changes every time. If you
move the app or the `.AppImage` file later, the next time you open Jarvis it
sees that the unit names another copy and writes the unit again from the
new place. That restarts the daemon.

### Windows

A value named `JarvisDaemon` under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which runs
`Jarvis.exe --jarvis-daemon` when you sign in. It needs no administrator
rights. That flag makes the app start the daemon in the background, with no
window, and exit.

Windows has no service manager watching the daemon. If it crashes it stays
down until you sign in again or open Jarvis. If you move the Jarvis folder,
the next time you open Jarvis it writes the `JarvisDaemon` value again with
the new path.

## Security

**The control socket is owner-level access.** Anything that can connect to
it and prove it knows the secret can do what the Settings window does. That
includes setting the owner password, approving a pairing, revoking devices
and opening terminals. The owner password is not asked for, because only you
can reach the socket. It never leaves this machine: there is no network
listener for it. The remote bridge and the browser client never see its
requests.

What keeps it yours:

- **File permissions.** On macOS and Linux the run directory is 0700 and the
  socket and secret are 0600, owned by you. On Windows the files sit in your
  user profile, whose permissions already limit it to you.
- **A shared secret that never goes on the wire.** Connecting is a mutual
  HMAC-SHA256 challenge: the client sends a random nonce, the daemon proves
  it knows the secret first, then the client proves it too. A process that
  pretends to be the daemon learns nothing it could reuse. A wrong proof
  closes the connection without a reply.
- **A random pipe name on Windows.** Named pipes share one namespace across
  all users, so the name is random at every start and published only in the
  run directory. Another user cannot guess it in advance and pose as the
  daemon.
- **Limits before sign-in.** At most 16 connections can be in the middle of
  the handshake at once, and the client reads at most 4 KiB before the
  daemon has proved itself.

Anyone who can read your home directory as you can use the socket, just as
they could read your SSH keys. The daemon adds no protection against
software already running as your user.

The remote bridge and browser client work the same whether Jarvis runs in
the app or in the daemon. See [Remote access](remote-access.md).

## Troubleshooting

**"Another jarvisd is already running" (exit 3), and none is.** The lock in
`jarvisd.pid` is stale. The daemon clears a stale lock itself: when the pid
in it is dead, is its own, or is alive but nothing answers on the socket. If
a start still fails, check that no `jarvisd` process is left (`ps aux | grep
daemon-main`), then delete `jarvisd.pid` and `jarvisd.pid.takeover` from the
run directory.

**"The Jarvis daemon runs a different build. Restart it, then try again."**
After an update, the app and the CLI refuse to talk to a daemon from an
older build. The app restarts the daemon itself, at most three times in ten
minutes: through the service manager, or on Windows by stopping it and
starting the new one. After that the status line says it failed. Stopping
works across builds, so **Stop now**, turning the setting off, **Run inside
the app this time** and `jarvisd stop` all reach an old daemon. For the CLI,
restart the daemon: **Settings → General → Restart daemon**, or on a machine
with no screen `systemctl --user restart jarvisd` (Linux),
`launchctl kickstart -k gui/$(id -u)/dev.jarvis.daemon` (macOS), or
`jarvisd stop` and then open Jarvis (Windows).

**The daemon keeps restarting.** A restart from Settings makes the daemon
exit with code 75, and launchd or systemd starts it again. That is
expected. Any other non-zero exit is a crash; the reason is in
`jarvisd.log`, or in `jarvisd.err.log` on macOS.

**"Restart the Jarvis daemon."** A daemon you started yourself with
`jarvisd run`, and any daemon on Windows, has no service manager to start it
again. When a setting needs a restart, stop it (`jarvisd stop` or Ctrl-C)
and start it again.

**The app says it couldn't reach its background service.** The dialog shows
the last line of `jarvisd.log`. Choose **Run inside the app this time** to
keep working, then look at the log.

**"Jarvis's background service won't stop."** A daemon started while
turning the setting on, or while the app tried to reach it, did not stop
when Jarvis gave up on it, and Jarvis will not run a second copy inside the
app. Quit Jarvis, stop the daemon (`jarvisd stop`, or restart the computer),
then open Jarvis again.

**"The Jarvis run directory … must have mode 0700", "… is owned by another
user" or "… is a symlink".** The daemon refuses a run directory that someone
else could read or redirect. Fix the directory (`chmod 700
~/.config/jarvis/run`), or delete it and let the daemon create it again.
