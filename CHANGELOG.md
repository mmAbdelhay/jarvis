# Changelog

Notable changes, newest first. Dates are the date the release was tagged.

Each released version has its own page on the
[releases](https://github.com/mmAbdelhay/jarvis/releases), with the long
version and the downloads. This file is the index.

## Unreleased

- iPhone and iPad, for free: every release now carries an unsigned IPA
  built by CI, installable with AltStore or SideStore under your own free
  Apple ID (7-day refresh, no push notifications — the app says so in
  Settings instead of failing silently). An AltStore/SideStore source
  feed serves updates; the docs gain a full
  [iPhone and iPad](docs/guide/ios-install.md) guide, including the
  Tailscale/SideStore VPN toggle automation.
- iPad runs as a real tablet app (`ios.supportsTablet`), not a scaled-up
  iPhone one.
- Sideloaded builds warn before they expire: a Dashboard banner under
  2 days and a local notification a day ahead, read straight from the
  embedded provisioning profile.

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
