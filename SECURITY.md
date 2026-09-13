# Security

## Reporting a vulnerability

Please **do not open a public issue.** Use GitHub's private vulnerability
reporting instead: the **Security** tab on this repository, then **Report a
vulnerability**. That opens a thread only you and the maintainer can see.

Useful to include: what an attacker can do, what they need first, your OS and
Jarvis version, and the smallest sequence that shows it. A proof of concept is
welcome and never required.

This is a single-maintainer project with no on-call rotation. Expect a first
reply within about a week. If a report is confirmed, the fix and the release
that carries it will credit you unless you ask otherwise.

## Supported versions

The latest release only. There are no maintenance branches, and a fix ships in
the next release rather than as a patch to an older one.

## What is in scope

Jarvis is a desktop app for one person on one machine. It has no server, no
accounts, and no multi-tenancy — so the interesting boundary is not "other
users of Jarvis" but "other machines on your network" and "content a Workspace
tab loads".

In scope, roughly:

- The Database tab's DbGate instance, which listens on `0.0.0.0` with a
  per-spawn random password. Anything that leaks that password, survives the
  tab closing, or lets the instance be reached without it.
- The Editor tab's `code-server`, which runs with `--auth none` and must stay
  bound to `127.0.0.1`. Anything that moves it off loopback.
- The renderer's isolation from the pages the Personal browser and the
  Workspace tabs load — a page reaching the Electron main process, the
  preload bridge, or another project's session.
- `~/.config/jarvis/jarvis.yaml` and the session store: anything that writes
  them from outside the app, or reads secrets out of them.
- The shell integrations installed into bash, zsh and PowerShell.

## What is not in scope

These are design, stated plainly in the README under "What it exposes":

- **Agents run as you.** Every session is a real process under a real pty with
  your environment, your PATH and your credentials. Jarvis adds no sandbox of
  its own, and an agent doing something destructive is the agent's behaviour,
  not a vulnerability in Jarvis.
- **The Database tab is reachable from your network while it is open.** DbGate
  offers no bind-address option. That it is reachable at all is known and
  documented; that its password could be bypassed or leaked is not.
- **Builds are not code-signed.** The macOS `.dmg` is ad-hoc signed and the
  Windows `.zip` is not Authenticode-signed, so both warn on first launch.
  This is a cost of a hobby project, not an oversight.
- Anything requiring an attacker who already has your user account on your
  machine — at that point the agents' credentials are already theirs.
- Findings from automated scanners with no demonstrated impact here.
