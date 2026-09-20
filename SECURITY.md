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
- The mobile remote bridge (`remote:` in `jarvis.yaml`, `~/.config/jarvis/remote/`).
  In scope: anything that makes it listen while `remote.enabled` is off, or
  while enabled with zero paired devices and no pairing window open; anything
  that pairs a device without the on-screen confirmation naming it; anything
  that authenticates a connection without a valid device token (tokens do
  not expire — see "a paired device is you" below on why revoking a lost
  device is the only way to invalidate its token);
  anything that reaches a desktop-only channel (`remote:bindChoices` and the
  rest) from a phone connection; anything that leaks a device token or the
  pairing secret — in the audit log, a status payload, a push notification or
  anywhere else; anything that keeps working after a device is revoked;
  anything that delivers terminal, agent-session or Docker output to a
  connection that did not subscribe to that pane, session or tab; a phone
  reading or replacing a Docker log follower it did not start; and a slow or
  silent phone growing the laptop's memory without bound. Push notifications
  (`remote.push.enabled`, off by default) leave the machine through Expo's
  push API to Apple or Google; in scope is any notification payload carrying
  terminal or agent output, a command, a path, a transcript, a device token
  or a fingerprint, and any push sent while `remote.push.enabled` is false
  or to a device that did not register a token.

  The bridge can turn itself off (`remote.idleDisableMinutes`) after that many minutes with no paired device connected and no pairing code open; when it does, Jarvis writes `remote.enabled: false` into `jarvis.yaml` itself. In scope is anything that keeps the listener open past that time without an authenticated device, and anything that reopens it without a save.

  The audit log at `~/.config/jarvis/remote/audit.log` (0600, one rotation at 5 MiB) records pairings, connections, auth failures, revocations, every mutating call and the first input into each session or pane per connection, refused calls (capped per connection), pushes the laptop queued, and idle shut-offs — by device id and channel name only. In scope is any audit line carrying a token, a secret, an argument, a path, output or a message body.
- The sidecar reverse proxy (`remote.sidecarProxy`, `/s/{handle}/…` on the
  bridge listener), which fronts `code-server`, DbGate and Headlamp for a
  paired phone. In scope: a sidecar's own loopback port becoming reachable
  from the phone directly rather than only through a handle; a handle,
  cookie or one-time key that is guessable, reusable after its window, or
  reused across sidecars or devices; one sidecar's cookie or another
  device's handle leaking into a request the proxy forwards; a response
  other than a closed socket with no bytes for any plain HTTP request that
  is not a validly authenticated `/s/{handle}/…` request (the `/rpc` and
  `/pair` upgrades are unaffected by this and are answered as before); a
  revoked device's
  handles, cookies or already-open sidecar sockets (including a streaming
  response or a code-server terminal's WebSocket) still working after the
  revoke; the proxy connecting anywhere other than `127.0.0.1:<the port
  recorded when that handle was published>`; and DbGate's basic-auth
  credential (injected server-side per Electron's `login` event, or by the
  proxy) reaching a phone, a log, or any origin other than the loopback
  DbGate instance it belongs to.

## What is not in scope

These are design, stated plainly in the README under "What it exposes":

- **Agents run as you.** Every session is a real process under a real pty with
  your environment, your PATH and your credentials. Jarvis adds no sandbox of
  its own, and an agent doing something destructive is the agent's behaviour,
  not a vulnerability in Jarvis.
- **The Database tab is reachable from your network while it is open.** DbGate
  binds every interface and offers no way to ask for loopback — it isn't a
  flag Jarvis forgot to pass, `dbgate-api` never reads a host from anywhere.
  The per-spawn random password is the only thing standing in front of it,
  and the instance stops when the tab closes; that DbGate is now spawned
  with `BASIC_AUTH=1` and the desktop's own Database tab logs itself in
  through it (Electron's `login` event, `packages/desktop/src/dbgate-login.ts`)
  changes how the desktop tab authenticates, not what guards the instance
  from the LAN — it is still that same per-spawn password, on every
  interface, unchanged. On a shared network, that means
  anyone who can reach your machine can reach an open Database tab; close the
  tab before joining one, and prefer a VPN interface over a broadcast LAN
  when you can choose. That it is reachable at all is known and documented;
  that its password could be bypassed or leaked is not. This is independent
  of the mobile remote bridge, but the two compound: if you enable the bridge
  on a LAN-facing interface, both are now listening off loopback for
  unrelated reasons, and you should know about both before you do.
- **A paired device is you.** The remote bridge's device token is not a
  scoped-down credential — it is equivalent to an interactive shell on this
  machine as you, the same as every agent session already is: it can run
  commands (terminal input, a git commit, `docker compose`), read files, and
  reach every project this machine can. A paired phone can also open a new
  shell in any configured project (`terminal:open`) — the same trust weight
  as sending input into one already running, not a wider grant. That is design, not a vulnerability;
  the confirmation dialog exists so you know that before you approve one. A
  paired phone can watch the live output of any open terminal pane and
  running agent session, which can include anything printed there (tokens
  echoed by a command included).
  A paired phone can also ask the laptop to list the agent processes it
  finds running outside Jarvis (`sessions:refresh`, a `read` channel) —
  only the user's own agents' names, working directories and pids, never
  the command-line arguments any of them was started with.
  It can upload audio recordings (up to 4 MiB each) that the laptop decodes
  with `ffmpeg` using a fixed input format and no network protocols, in a
  private temporary folder deleted before the request answers; a decoder
  vulnerability in the installed `ffmpeg` is therefore reachable from a
  paired device.
  In this release, sending or scripting an API request, saving API settings
  (a proxy, TLS verification), and changing Jarvis's own settings (Settings'
  save, and testing an agent command) are all desktop-only — a paired phone
  cannot reach any of them, and cannot change which command an agent runs or
  which directories are configured as projects. If a device is lost or a
  token might be compromised, revoke it from **Settings → Remote access** — this
  closes any live connection from it immediately. A `devices.json` that
  fails to parse is treated as an error, not an empty file: the bridge
  stays off rather than risk silently unpairing (or admitting) devices from
  a corrupt read. Deleting `~/.config/jarvis/remote/cert.pem` and `key.pem`
  does not itself unpair anything: the next time the bridge's listener
  starts (the next launch, or the next time it opens after being off), a
  fresh certificate with a different fingerprint is minted, and every
  already-paired phone that pinned the old fingerprint — every phone paired
  against the self-signed default, or against a configured certificate with
  no DNS name — fails to reconnect and has to be paired again. A phone
  paired instead against a *configured* certificate with a
  DNS name (`remote.tls.certPath`/`keyPath`, e.g. `tailscale cert`) trusts
  that name through the OS trust store rather than pinning a fingerprint, so
  a routine renewal under the same name reconnects with no re-pair; only a
  change to the name itself, or a fall-back to the self-signed default,
  forces one. Revoked or not, entries stay in `devices.json` and keep
  counting as "a device is paired" (so the bridge keeps listening) until you
  revoke them from Settings; a certificate rotation you didn't expect is a
  sign to open **Settings → Remote access** and revoke anything that
  shouldn't still be there.
- **Builds are not code-signed.** The macOS `.dmg` is ad-hoc signed and the
  Windows `.zip` is not Authenticode-signed, so both warn on first launch.
  This is a cost of a hobby project, not an oversight.
- Anything requiring an attacker who already has your user account on your
  machine — at that point the agents' credentials are already theirs.
- Findings from automated scanners with no demonstrated impact here.
