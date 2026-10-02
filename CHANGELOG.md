# Changelog

Notable changes, newest first. Dates are the date the release was tagged.

Each released version has its own page on the
[releases](https://github.com/mmAbdelhay/jarvis/releases), with the long
version and the downloads. This file is the index.

## Unreleased

- Phone redesign, files: a terminal's Files button browses its project
  (folders first, a breadcrumb back up) and types a chosen file's path into the
  terminal, quoted when the shell would misread it. `terminal:listDir` now also
  takes a path relative to the project root, checked by the same containment
  rule.
- Phone redesign, terminal: the plan stays in view above the keys (progress,
  the step it is on, notes waiting to be sent) and opens a restyled sheet with
  a Plan / Notes switch and ticked steps struck through. Getting around the
  output: previous / next command (from the shell's own prompt marks),
  Latest once scrolled back, find in output, and a drag pad for arrow keys.
- Phone redesign, Session and Changes: a session screen switches between Live,
  Changes, Plan (with its progress) and Transcript; its plan opens on the
  session, and notes on it are sent to the session (`plans:send` now also
  accepts a live session id). Changes shows one branch card (branch picker,
  ahead/behind, Pull / Push / Pull request, the worktree's merge and remove), a
  file list with status badges and staged toggles, and a commit bar.
- Phone redesign, Sessions and History: Sessions has a search field and
  status chips (All, Waiting, Running, Done) with live counts; History searches
  on the laptop, groups by day and loads 50 sessions at a time instead of all
  of them (`history:list` takes an optional page request; with none it answers
  the whole list as before).
- Phone redesign, Home: a new bottom bar (Home, Sessions, a Talk button in the
  middle, Workspace, Changes); any question a session is waiting at, answerable
  from Home; and each account's capacity with its last-day trend.
- Phone Changes screen: pull, push, open a pull request, switch or create a
  branch, and merge or remove a session's worktree. A commit git refuses now
  says why on the phone and keeps the draft.
- Imported Copilot CLI sessions open with their conversation: History reads
  the session's `events.jsonl` instead of showing an empty view.
- Find in an API response: a search field above the body marks every match,
  counts them, and steps through with Enter / Shift+Enter.

- The API client copies a request as JavaScript `fetch` or Python
  `requests` as well as cURL, from one menu. All three come from the same
  resolved request, so they agree on headers, auth and body.

- **Check for updates** in Settings → General: one request to GitHub's
  releases API, only when pressed, with the newer release's page opened in
  the Personal browser. Nothing is ever checked in the background.

- The plan panel shows a plan's checklist progress in its header ("3/7
  done", with a meter), counted from its own `- [ ]` / `- [x]` items.

- Answer a waiting session without its terminal. A session sitting at a
  permission menu, a `(y/n)` or a "Press Enter" shows the agent's own
  question and options on its Dashboard row and on the phone's session
  screen, and by voice ("say no to the acme session"). Each answer types
  what you would, and is refused — typing nothing — if the prompt changed
  since you saw it.

- Usage history on the Dashboard: a line under each provider's meter shows
  its remaining capacity over the last day, and the Sessions header shows
  sessions started per day for the last two weeks. Readings are kept as
  they arrive (30 days, in `sessions.db`); nothing extra is ever queried.

- Sessions can run in a git worktree of their own, so two agents in the
  same project stop writing over each other. `sessions.worktrees:
  parallel` gives one to a session started while another is live in the
  same checkout; `always` gives one to every session; asking for "a
  separate worktree" works whatever the setting. The session's Changes
  view can merge it back into the project's branch (refused over
  uncommitted work, backed out on conflict) or remove it, keeping the
  branch. Off by default: a fresh worktree has no installed dependencies.

- The Changes view finishes the git loop: a branch picker and **New
  branch**, where the branch stands against its remote (`↑2 ↓1`),
  fast-forward-only **Pull**, never-forced **Push** (the first push sets
  the upstream), and **Pull request**, which opens the branch's pull
  request — or creates it with `gh` — in the project's browser tab.

- The file sidebar keeps itself current: it re-reads after every command
  and every few seconds while it is on screen, keeping open folders open
  and leaving unchanged rows alone. Right-click for **New file**, **New
  folder**, **Rename** and **Move to Trash** (or use the two buttons by the
  header); names are typed in place, nothing is ever overwritten, and every
  write is held to the project root the same way listing is.
- The plan panel has a user guide section, under Workspace tabs → Terminal.

## [0.1.5] — 2026-09-28

- Plan panel in every terminal tab: the plan Claude Code writes in plan
  mode opens beside the terminal on its own (without taking focus), and
  any `docs/superpowers/specs` or `plans` file in the project can be
  picked. Click a section to edit it in place (⌘S saves just that
  section; if the file changed on disk, a notice keeps your text), pin
  comments to a selection or a section, and **Send to Claude** pastes
  them into the tab as one message. Toggle it from the palette (⌘P →
  Toggle plan panel) or the tab's right-click menu. The phone's terminal
  screen gains a **Plan** sheet with the same comments and per-section
  editing. Plan files are only read or written inside plan folders;
  remote images in plans never load, and links open only if they are
  http, https or mailto.
- Tablet and desktop layout for the browser client and the iPad and
  Android tablet app: a window at least 744 wide (an iPad mini in
  portrait) whose shorter side is at least 600 gets a desktop-style top bar (sections, the laptop's metrics,
  connection and name, running count, clock), a three-panel Dashboard,
  Sessions as a list beside the selected session (`/sessions?id=`),
  terminals and tools inline in the Workspace, and a section list in
  Settings. Other pages sit in a centred panel, and unlock and pairing in
  a centred card. Resizing or rotating keeps the open session or terminal
  without reconnecting it, Arabic mirrors the layout, and tablets are no
  longer locked to portrait. Phones are unchanged. A hardware keyboard
  does not type into the terminal in the native iPad app; use the key bar
  and compose bar. See [Phone and tablet/desktop
  layouts](docs/guide/remote-access.md#the-browser-client).
- Background daemon: **Settings → General → Keep Jarvis running in the
  background** (`daemon.enabled`, off by default) moves terminals, agent
  runs, the remote bridge and the browser client into `jarvisd`, a
  background process that keeps running after you quit the app. It is
  registered as a LaunchAgent on macOS, a systemd user unit on Linux (use
  `loginctl enable-linger` on a headless server) and an HKCU Run value on
  Windows. Reopening the app shows the same tabs and terminals. Turning it
  on or off closes the terminals that were open. The new `jarvisd` command
  (`status`, `set-password`, `pair`, `devices`, `revoke`, `sign-out-all`,
  `web on|off`, `stop`, `run`) administers it with no window, for example
  over SSH. It uses a local control socket that only your user can open,
  and a launcher ships in the app's `resources/bin`. See [Background
  daemon](docs/guide/background-daemon.md).
- Owner login for remote access: pairing now identifies a device, and
  every connection stays locked until it signs in with an owner password
  set in Settings → Remote access → Owner account (at least 12
  characters). The bridge does not start without one, so a bridge that
  was on before upgrading stays off until the password is set. Sign-ins
  use 15-minute access tokens and rotating refresh tokens (7 days idle,
  30 days at most); a reused refresh token ends that sign-in and raises a
  desktop notification. Wrong passwords lock a device out from 1 minute
  up to 1 hour, and 20 in an hour pause all sign-ins for 15 minutes.
  Changing the password, deleting a passkey, Sign out everywhere or
  revoking a device ends sessions and cuts sidecar tabs. The phone app
  unlocks with Face ID, fingerprint or passcode after the first password
  sign-in, and locks itself after 15 minutes idle (adjustable).
- **Breaking:** the remote wire protocol is now version 2. Update the
  phone app and Jarvis on the laptop together; either one alone refuses
  to connect ("Update the Jarvis app"). Pairing codes made before the
  upgrade are refused, so make a new one.
- Browser client: the phone app now also runs in a web browser, served
  by Jarvis itself from a second listener. It is off by default
  (`remote.web.enabled`) and has its own port (`remote.web.port`, the
  bridge's port plus one by default), and it needs a Tailscale certificate
  with a DNS name and the owner password. Open or pair it from Settings →
  Remote access → Browser access (address, Open in browser, QR code) or by
  opening a `https://<name>:<port>/pair#…` link. A browser signs in with
  the owner password or a passkey, and can optionally stay signed in. It
  has no push notifications and no QR scanning, and Editor, Database and
  Cluster open in a new tab. Settings labels each paired device Browser or
  App.
- Voice uploads accept WebM/Opus as well as MP4/AAC, so browsers that
  cannot record MP4 can send voice. The laptop checks the recording's
  actual container against the format it was sent as.
- The bridge now checks `Origin` on `/rpc` and `/pair` connections. It
  accepts no `Origin`, the phone app's `jarvis-app://native` (which the
  updated app sends), or the browser client's own address while browser
  access is on. Anything else, including the bridge's own address where
  sidecar pages run, is closed without a reply.

## [0.1.4] — 2026-09-20

- Phone companion app (`apps/mobile`): pair over the local network or
  Tailscale, watch and drive sessions, open terminals, review changes, and
  use the Editor / Database / Cluster tabs on the phone through an
  authenticated sidecar proxy (real certificate required; issued from
  Settings via Tailscale).
- Remote bridge (`@jarvis/remote`): TLS listener with pinned or real
  certificates, device pairing with per-device tokens, push
  notifications (opt-in), audit log, idle auto-off. Off by default.
- Dashboard redesign: the core orb with orbiting agents, glowing threads
  to centred project cards, wider scrollable Providers panel, session
  refresh with discovery of agent sessions running outside Jarvis (cached
  across launches until refreshed).
- Provider capacity meters read for free for Claude (status-line
  snapshot), Codex (its own session logs) and Copilot (the CLI's own
  account via keychain, gh fallback) — never a billed query.
- Prayer notifications before and at prayer time, configurable in
  Settings.
- Workspace: per-project tab strip with rename, colour bands, stable
  reconcile; the project switcher follows tabs opened from Dashboard
  cards.
- Desktop window opens maximized; Settings → Remote access offers Local
  Wi-Fi or Tailscale with Tailscale certificate issuance built in.

## [0.1.3] — 2026-09-13

Linux and Windows, a first-run screen that installs what Jarvis needs, and the
prerequisites screen finally closing when you press Skip.

Everything since 0.1.2 in one build, from one commit, on all three platforms —
the 0.1.2 assets were each built from a different source state.

### Added

- **Linux.** AppImage target, PulseAudio recording, Piper for speech, the menu
  bar hidden without losing the edit roles, CPU temperature on the Dashboard
  where the machine reports one, and bash shell integration — blocks, history
  and the file sidebar — alongside the zsh one.
- **Windows.** ptys, the PowerShell terminal, voice, and a `.zip` built beside
  the `.dmg` and the AppImage. Chords are Ctrl+Shift rather than ⌘, and Jarvis
  says so at startup when another app is already holding Alt+Space.
- **A first-run prerequisites screen.** It names the external tools Jarvis can
  use, what each one unlocks, and whether you have it — and installs the ones
  you tick. Nothing installs until you press the button, and anything needing
  root is shown as a command to copy rather than run. Reachable again later
  from Settings.
- **`pnpm bootstrap`**, which performs the two install steps a global
  `ignore-scripts` suppresses: fetching the Electron binary and building
  node-pty's native binding.
- **CI, and the tooling it gates on.** Biome for formatting and linting, and a
  workflow that runs `pnpm lint`, `pnpm typecheck`, `pnpm build` and
  `pnpm test` on Linux, macOS and Windows for every pull request.
- `CONTRIBUTING.md`, `SECURITY.md`, `NOTICE` and this file.
- **A documentation site** at
  [mmabdelhay.github.io/jarvis](https://mmabdelhay.github.io/jarvis/), built
  from the markdown already in the repository, with search across every page.
- **Screenshots** of the Session table, the Editor tab and the Terminal, in the
  README and in the guides.

### Changed

- One chord table, resolved per platform, so every hint in the app names the
  chord that platform actually uses.
- Windows paths resolve the same way on every OS, with a real `cmd.exe`
  fallback.
- **Node 24 is now the documented minimum**, not 22. The session store is built
  on `node:sqlite`, which Node 22 does not carry — the test suite does not even
  load there. The guides had said 22 since before the session store existed.

### Fixed

- Sidecars resolve their `PATH` when they spawn rather than when they were
  built, and a sidecar that will not start logs why instead of being dropped.
- Piper is given its text on stdin; it has no input-file flag.
- The prerequisites screen installs what it says it will on macOS.
- **The prerequisites screen closes.** It had never closed: `.setup-overlay`
  set `display` on its base rule, which out-cascades the UA stylesheet's
  `[hidden] { display: none }`, so Skip set the attribute and nothing moved.
  Reported as "it opens every launch" — it did not open every launch, it never
  went away. Two latent instances of the same cascade bug went with it.

## [0.1.2] — 2026-09-10

DevTools dock left, bottom, right or undocked, with the side and size
remembered. A page's `window.open` gets a real window, so Microsoft and Google
sign-in popups can report back through `window.opener`. `getDisplayMedia`
works: "Present now" in Google Meet opens macOS's own screen picker.

## [0.1.1] — 2026-09-08

Two bugs that only appeared in an installed build. An agent's command is now
resolved on the login shell's `PATH`, not the `/usr/bin:/bin:/usr/sbin:/sbin`
a Finder-launched app inherits — an installed Jarvis had been opening with "No
agents are working". Copilot sessions appear in the history table, and both
CLIs are found without being told where their config lives.

## [0.0.9] — 2026-09-08

The first build anyone but the author could install. It opens on a machine
that has never run Jarvis, writing the smallest config that works instead of
quitting with a dialog. There is a `.dmg`. Terminal blocks, the file sidebar
and the command palette work in an installed build.

## [0.0.4] — 2026-09-06

A Settings save no longer deletes the config sections it does not know about.
`toRawConfig` is the sole allowlist of keys that reach `jarvis.yaml`, and
`terminal:`, `workflows:` and `sessions:` were missing from it — so saving
anything at all silently dropped them. The guard is a
`Record<keyof JarvisConfig, …>` that will not compile until a newly added
section appears in it.

## [0.0.3] — 2026-09-05

Jarvis gives back what it is not using. A tab hidden for 15 minutes releases
its renderer and rebuilds on click; a sidecar no open tab needs is stopped
after 10 minutes and restarted on the next open. Measured at 414 MB of
renderers before the sweep and 260 MB after. All of it configurable under
`performance:`, and `0` restores the old behaviour exactly.

## [0.0.2] — 2026-09-05

DRM video: Netflix and Prime Video play in the pane, with Picture-in-Picture.
Built on castLabs' Electron for Content Security rather than stock Electron,
with a production VMP signature applied at package time. Bookmarks can be
renamed in place.

## [0.0.1] — 2026-09-04

The first packaged build — a real macOS `.app` rather than a `pnpm start`.

[0.1.3]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.3
[0.1.2]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.2
[0.1.1]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.1
[0.0.9]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.0.9
[0.0.4]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.0.4
[0.0.3]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.0.3
[0.0.2]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.0.2
[0.0.1]: https://github.com/mmAbdelhay/jarvis/releases/tag/v0.0.1
