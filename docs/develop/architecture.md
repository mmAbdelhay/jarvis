# Architecture

Five packages in a pnpm workspace, and the direction of every import between
them is the whole design — plus a phone app that lives outside the Electron
diagram entirely. This table is the ground truth (each package's own
`package.json` `dependencies`, cross-checked against what its `src` actually
imports):

| Package | Imports (workspace) | Role |
|---|---|---|
| `@jarvis/wire` | none | the shared wire protocol — no Node, no other package |
| `@jarvis/core` | none | pure logic — no Node, no Electron, no filesystem |
| `@jarvis/remote` | `@jarvis/wire` | the remote bridge's transport |
| `@jarvis/platform` | `@jarvis/core` | the machine: processes, ptys, sqlite, git, http, files |
| `@jarvis/desktop` | `@jarvis/core`, `@jarvis/platform`, `@jarvis/remote` | Electron: main process + preload + renderer |
| `apps/mobile` | `@jarvis/wire` (values + types), `@jarvis/core` (type-only) | Expo Router + React Native — never `remote`, `platform` or `desktop` |

`core` knows nothing about the world it runs in, which is what makes the
orchestrator, the tab store and the URL rules testable without mocking an
operating system. `platform` is where every side effect lives, always behind an
injected dependency so the orchestration around it can be tested with a fake.
`desktop` composes core, platform and remote, and adds the window.

**`@jarvis/remote`** is a peer of `platform` that `desktop` also imports. It
is where the remote bridge's transport lives — the pinned-TLS listener, the
pairing and device/token machinery, the frame protocol underneath the
Settings' Remote access panel, and (M11) the sidecar reverse proxy that
serves `/s/{handle}/…` beside the listener's other two routes, `/rpc` and
`/pair` — kept out of `platform` so that "what in this app can listen?" has
a one-directory answer. The proxy hop only ever connects to
`127.0.0.1:<port>`, so nothing about it changes what this package can reach
on the network. It never imports `platform`,
`desktop` or Electron (`remote/src/import-direction.test.ts`). Its source may
use `node:*`, `@jarvis/wire`, `@jarvis/core`, relative imports inside `src/`,
and the per-file third-party table enforced by that test: `ws` in `server.ts`
and `probe-client.ts`, and `@peculiar/x509` plus `reflect-metadata` in
`certificate.ts`. The only workspace package `remote` imports is `@jarvis/wire`;
`@jarvis/core` is allowed by the per-file test but not currently imported.
The import-direction test is the allowlist, not the package diagram's shorthand.

**`@jarvis/wire`** is the fifth package, and the smallest: `PROTOCOL_VERSION`,
close codes, the `ClientMessage`/`ServerMessage`/pairing-link types, the wire
patterns (secret, device id, fingerprint, subscription key) and the address
normaliser, all as pure functions and constants — no `node:*`, no import from
any other workspace package
(`packages/wire/src/no-node-imports.test.ts`). `@jarvis/remote` re-exports
these from its own modules rather than duplicating them, so nothing outside
`remote` had to change when `wire` was carved out; `apps/mobile` imports the
same package directly, which is the whole point — a phone client and a
Node-based bridge speaking one protocol definition instead of a hand-copied
second one.

**`apps/mobile`** is not part of the Electron diagram above and is not built
or typechecked by the root `tsc -b`/`vitest run` — it has its own
`tsconfig.json` and `vitest.config.mts` (see
[testing](testing.md)). It may import, from the workspace, only
`@jarvis/wire` (values and types) and, type-only, `@jarvis/core`; never
`@jarvis/remote`, `@jarvis/platform` or `@jarvis/desktop`, which all assume a
Node or Electron process the phone does not have.

The session screen renders a display-only xterm page in a locked WebView; native compose and key controls send raw input over the shared client. `apps/mobile/scripts/build-terminal-html.mjs` reads the desktop's vendored terminal bundles and palette only at generation time. The committed page has one hashed script, no network access and LTR terminal layout; tests detect drift from those inputs.

## Three platforms

macOS, Linux and Windows, and the rule that keeps them one codebase: **a
function whose behaviour differs by OS takes the platform as a parameter**.
Only the process entry points read `process.platform` — `main.ts`,
`preload.cts`, `daemon-main.ts` and the `jarvisd` CLI (`jarvisd.ts`) — plus
`pty.ts` and `sdk-executable.ts`, which locate per-platform native binaries.
The renderer receives it over the bridge as `window.jarvis.platform`.
`platform-convention.test.ts` holds that allowlist.

This is not tidiness. A function that reads `process.platform` at the point
of use can only be tested on the OS the test happens to run on, and two
thirds of the app would be asserted by nothing. Taking it as a parameter
means every branch runs on every OS. See [conventions](conventions.md).

**CI runs the whole suite on all three.** `.github/workflows/ci.yml` runs
one job per OS (`ubuntu-latest`, `macos-latest`, `windows-latest`, with
`fail-fast` off) on every pull request and every push to `master`. Each job
uses Node 24 and runs `pnpm install --frozen-lockfile --ignore-scripts`,
`pnpm bootstrap --pty-only` (the node-pty binding, compiled on Linux),
then `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test`.
`.github/workflows/docs.yml` builds the docs site on Ubuntu and publishes
it from `master`.

The places that actually differ are few, and each is a named function with
every branch tested:

| Concern | Module |
|---|---|
| Shell integration | `platform/zsh-integration.ts`, `bash-integration.ts`, `powershell-integration.ts`, dispatched by `shell-integration.ts` |
| Which shell, and how it is started | `platform/shell.ts` — `shellCommand`, `shellArgs` |
| History format | `platform/completion.ts` — `parseZshHistory`, `parseBashHistory`, `parsePowerShellHistory` |
| Resolving a bare command name | `platform/executable.ts` — `resolveExecutable` (PATHEXT, `.cmd` through cmd.exe) |
| Microphone | `desktop/recorder.ts` — `recorderCommand` (avfoundation, PulseAudio, DirectShow) |
| Audio playback | `platform/piper.ts` — `audioPlayer` |
| Speech routing | `platform/piper.ts` — `RoutedSpeech`, `silentSpeech`; Windows' system voice is `platform/speech-windows.ts` |
| Voice hotkeys | `desktop/hotkeys.ts` — `registerVoiceHotkeys` (a fallback pair on Windows) |
| Keyboard chords and their labels | `desktop/renderer/keys.ts` |
| Application menu | `desktop/app-menu.ts` |
| Sidecar default paths | `platform/headlamp.ts` — `defaultHeadlampBinary` |
| The daemon's control endpoint | `desktop/daemon/control/endpoint.ts` — `controlPaths`: a Unix socket, or on Windows a named pipe with a random name per start (`windowsPipeName`) |
| The daemon's login item | `desktop/daemon/service-darwin.ts` (LaunchAgent), `service-linux.ts` (systemd user unit), `service-win32.ts` (an HKCU `Run` value, `JarvisDaemon`, that starts `Jarvis.exe --jarvis-daemon`) |

**What CI does not prove on Windows.** The unit tests for the service
builders and the pipe name run on every OS, but these are skipped on
`windows-latest`:

- The daemon's end-to-end tests: `daemon-main.e2e.test.ts`,
  `daemon/mode.e2e.test.ts` and `daemon/cli/jarvisd.e2e.test.ts`. None of them
  starts a real `jarvisd` on a named pipe.
- The `bin/jarvisd` launcher test (`jarvisd-launcher.test.ts`).
- The control test for an impostor server that cannot prove the secret.
- The socket adapter's restart-through-the-service-manager test, because
  Windows has no service manager that restarts `jarvisd`.
- File-mode checks (0600/0700), because Windows relies on the user
  profile's ACL.

So on Windows, background mode (the `Run` value, `--jarvis-daemon`, the
named pipe and restarts) rests on unit tests and a manual pass, not on CI.
The Editor tab has no Windows build at all (code-server ships none); see
[installation](../guide/installation.md#on-windows).

## Inside `desktop`

```
src/main.ts              the Electron host: owns the window, holds one CoreClient
src/core/compose.ts      createCore — the whole core, with no window (below)
src/core/core-client.ts  the CoreClient seam and its in-process adapter
src/core/tab-host.ts     TabHost: the Workspace's tab state, Electron-free
src/ipc.ts               handler bodies, as pure functions over injected deps
src/dispatch.ts          the one table of handlers, keyed by channel, any transport
src/desktop-only.ts      the few handlers that need a window, a dialog or a view
src/preload.cts          the only bridge; contextIsolation is on
src/view-reconciler.ts   ViewReconciler: one WebContentsView per tab that wants one
src/browser-host.ts      HostedView and ViewFactory: the types a view is built to
src/electron-view.ts     the one file that constructs a WebContentsView
src/daemon-main.ts       jarvisd: the core behind a local control socket
src/daemon/              the control socket, service installers, mode switching
src/sidecar-reaper.ts    when a sidecar nobody is looking at should be stopped
src/remote-idle.ts       the write-back after the bridge's idle timer fires
src/remote-access.ts     the request, push and audit lane between core and remote
renderer/                the UI. No Node. Type-only imports from the packages.
```

**The tab state is `TabHost`; the pages are `ViewReconciler`'s.** Which tabs
exist, their order, the active one, eviction past `MAX_TABS` (8 tabs that
hold a page) and what each page last reported live in `core/tab-host.ts`,
which has no Electron import and runs unchanged in the headless daemon. The
Electron half, `view-reconciler.ts`, *follows* that state: each snapshot is
diffed against the views it holds, a tab `hasView` wants gets a view, and a
view whose tab closed or was suspended is destroyed. Applying the same
snapshot twice does nothing. Bounds, visibility, DevTools and back/forward
are the reconciler's alone, because only a window can decide them. What a
page does crosses back as a small `PageFact` (`reportPage`). Electron stays
behind `ViewFactory` (`browser-host.ts`), so the reconciler runs in plain
Vitest too; `electron-view.ts` is the only place a view is constructed.

**Suspension is the host destroying a view and keeping its tab.** The
core's once-a-minute sweep asks the attached host to `sweepIdleViews()`;
the reconciler reports every tab that has sat hidden past
`performance.suspendTabsAfterMinutes` as `TabHost.suspend(id)`. The tab is
marked `suspended`, `hasView` turns false, and the reconciler destroys the
view on the next snapshot. The row stays, so nothing about the tab strip
changes; `TabHost.activate` sees the flag and asks for a fresh page.

This is tab suspension; it is separate from the remote bridge's idle
auto-disable, which closes the listener when no paired phone is connected and
no pairing activity is keeping it open.

Rebuilding needs one thing the host cannot know. A hosted app's sidecar may
have been stopped underneath it and restarted on a different free port, so the
address the tab was suspended holding points at nothing. `resumeUrl` is
injected into `TabHost` for exactly that: `createCore` routes the answer
through the same handler the tab's own button uses, so "reuse if running,
start if not" is decided in one place.

**Stopping a sidecar is decided outside the managers.** Nothing calls
`CodeServerManager.open()` again while you type in the editor, so a "last
used" stamp kept manager-side goes stale on the instance actually in use.
Only the workspace's tabs know what is needed, so the core computes that set
each sweep, right after the idle views are suspended, and `sidecar-reaper.ts` holds the grace period over it; the
managers only learn `stop(key)` and `runningKeys()`. `codeServerKey` is
exported and shared because the reaper builds its keys from config, from the
other end entirely.

**The renderer may import only *types*** from a workspace package. A value
import is a bare specifier that survives compilation and 404s at runtime in the
bundle; `no-value-imports.test.ts` enforces it, and it exists because that
mistake was made.

## The core and its hosts

Everything that is not a window — the dispatch table, the agents and ptys,
the sidecar managers, `TabHost`, the notifier, the remote bridge — is built
by one function, `createCore` in `core/compose.ts`. It imports no Electron
(`core/no-electron.test.ts`), so the same core runs in two places:

```
   Electron app (main.ts)                    jarvisd (daemon-main.ts)
   ┌──────────────────────────┐              ┌────────────────────────┐
   │ window, ViewReconciler,  │              │ createCore()           │
   │ preload, desktop-only    │              │  + remote bridge       │
   │          │               │   control    │  + web listener        │
   │     CoreClient ──────────┼── socket ────┤ daemon/binding.ts      │
   │   in-process │ socket    │   (local)    │ control/server.ts      │
   │          ▼               │              └────────────────────────┘
   │ createCore() (in-process)│
   └──────────────────────────┘
```

**`CoreClient` is the one door from the host into the core**
(`core/core-client.ts`; `main-core-seam.test.ts` keeps `main.ts` to it).
Two adapters implement it:

- `inProcessCoreClient` wraps a `createCore()` in the app's own process.
  Nothing is translated; a request reaches the dispatch table in the same
  tick.
- `connectSocketCoreClient` (`core/socket-core-client.ts`) speaks to
  `jarvisd` over the control socket. The synchronous reads (`firstRun`,
  `hostConfig()`, `workspace.state()`) come from a local cache that the
  connect snapshot fills and the daemon's pushes keep current. A drop
  rejects the calls in flight and reconnects with backoff; each reconnect is
  a full resync.

`switchableCoreClient` sits in front of both, so **Keep Jarvis running in
the background** moves every listener and the attached host from one core
to the other without a new window. `daemon/mode.ts` owns every transition
(launch, turn on, turn off, a daemon of another build) as pure logic over
injected doubles.

**The contract is JSON only.** Every argument and every result that
crosses is a plain object, array, string, finite number, boolean or null —
no `Uint8Array`, `Map`, `Date`, class instance or function. Binary crosses
as base64 (a favicon, decoded and capped at 256 KiB in the core). The
in-process adapter's `roundTrip` test mode pushes every value through
`throughJson`, so a non-JSON value fails a unit test rather than a socket.
Every stream is one ordered stream: a push the core sends while handling a
request arrives before that request settles, and a view request follows the
tab state that made it.

**The host gives the core a `DesktopHost`** (`core/host-link.ts`): window
focus, whether the screen is awake, favicon fetches, `sweepIdleViews`,
`destroyViews`, OS notifications, opening the system browser and restart.
With no host attached — a headless daemon — each answers safely ("not
focused, not awake") or is logged, never lost silently. The handlers that
need a real window, dialog, menu or view stay in the host
(`desktop-only.ts`) and never enter the core's table, so neither the bridge
nor the socket can reach them.

**`jarvisd`** is `daemon-main.ts` run under Node (packaged:
`ELECTRON_RUN_AS_NODE=1` against the Jarvis binary). The control server
starts first because it *is* the single-instance lock, then the core,
bound to the socket by `daemon/binding.ts`, then the bridge. Every request on
the socket runs with the desktop's own origin.

- **Where it listens.** A Unix socket in `~/.config/jarvis/run` (a 0700
  directory; socket and secret 0600). On Windows, a named pipe whose name
  is `jarvisd-` plus 16 random hex chosen at each start and published in
  `control.endpoint`, because the pipe namespace is machine-wide.
- **The handshake** (`daemon/control/handshake.ts`) is mutual HMAC-SHA256,
  server first. The daemon writes a fresh secret at every start; each side
  proves it knows it by signing the other side's fresh 32-byte nonce with
  its own label (`jarvisd-server` / `jarvisd-client`). The secret never
  crosses the wire, a recorded proof is useless on the next connection, and
  a squatter on the endpoint can neither harvest the secret nor pass the
  client's check. A client of another build is told `restart-required`.
- **The pid lock** (`daemon/control/lock.ts`) is `run/jarvisd.pid`,
  holding `<pid>:<random token>` and created exclusively. A lock is stale
  when its pid is dead, is this process's own, or is alive with nothing
  answering on the endpoint (checked twice, a grace period apart). Taking
  one over is serialised by a second exclusive file,
  `jarvisd.pid.takeover`, so of any number of racing starters exactly one
  wins; the others exit with code 3.
- **Service installers** (`daemon/service*.ts`) turn the setting into an
  OS login item: a LaunchAgent at
  `~/Library/LaunchAgents/dev.jarvis.daemon.plist` on macOS, a systemd user
  unit at `~/.config/systemd/user/jarvisd.service` on Linux, and a
  `JarvisDaemon` value under `HKCU\…\CurrentVersion\Run` on Windows. Each
  builder is a pure function of its inputs, tested on every OS; the service
  is re-installed when it names another binary (a moved app).

**Jarvis OS runs a second jarvisd entry.** `daemon/os/os-daemon-main.ts` is
`jarvisd` without the desktop core: the same control server, handshake, lock,
run directory and lifecycle, serving only the Jarvis OS channels (`agent:*`,
`provider:*`, `doctor:*`, `audit:list`, `updates:check`, `memory:*`,
`registry:list`, defined in `@jarvis/wire`'s `os-control.ts`) through
`daemon/os/os-binding.ts`. Behind them, `daemon/os/agent-service.ts` composes
`@jarvis/core`'s `agent/` module (tool loop with the safety rules on every
request, history fitted per request, safe calls four at a time, per-turn tool
search; risk gate; network doctor; provider failover; memory service) with
`@jarvis/platform/model` (Anthropic, OpenAI-compatible, Ollama and Gemini
adapters, MCP stdio client, keyring, audit log) and `@jarvis/platform/store`
(`node:sqlite` embedding cache, AES-GCM sealed memory store, loopback-only
Ollama embedder). Providers are an ordered list in `jarvis.yaml`'s `os:`
section, keys by id in the keyring. Add-on MCP servers registered in
`~/.config/jarvis/mcp.d/` start as transient `systemd-run --user` services
only when a sandbox probe proves the sandbox applies and their kept artifact
and unpacked files still match the signed index (`registry-servers.ts`); the
runtime dir and hidden home entries are out of their reach, and their tools'
risk follows their tier. With `JARVIS_TOOL_PROFILE=readonly` (the Docker
image) jarvisd offers only safe tools and reads provider keys from
`JARVIS_PROVIDER_KEY_<ID>`. Its `sys:snapshot` push also carries pending
updates (`updates-monitor.ts`: `updates.list` 2 min after start, then daily)
and the local model's download state (`model-state-reader.ts`,
`/var/lib/jarvis/model-state.json`). It runs on Linux only, is built by
`pnpm --filter @jarvis/desktop build:daemon` into one esbuild bundle in
`packages/desktop/dist-daemon/`, and never loads Electron, node-pty, a native
module or the Agent SDK (`daemon/os/os-bundle-graph.test.ts`). The desktop
app's `daemon-main.ts` and its orchestrator are untouched by it.

**Rafiq M3 (brain).** jarvisd routes every control request through one router that knows whether the computer (a control connection) or a paired phone (the `@jarvis/remote` bridge, started inside jarvisd from `remote:` in jarvis.yaml) is asking; phones get only `agent:prompt/stop/confirm/undo`, `audit:list`, `memory:list`, the `voice:utterance` blob and the `agent:events`/`sys:snapshot` pushes, never approve password-tier items, and are audited `phone:<name>`. Approved setters and file operations leave an `undo` call (last 20, same host server and family only). Push-to-talk (`voice:utterance`) uses Jarvis's `stt.ts`/`piper.ts` through `@jarvis/platform/voice`; a short yes/no classifies approval or denial of the visible card only while unlocked; the shell sends `agent:confirm` with its ticks. `sys:setLocked` is accepted only from `/usr/bin/jarvis-lock` (peer program read from the kernel via `ss` and `/proc/<pid>/exe`); while locked no card is answered by anyone, and the state survives a jarvisd restart in `$XDG_RUNTIME_DIR/jarvis/lock-state.json`.

Password-tier cards carry the secret `adminPassword`, verified by the helper for the calling user with pam_unix's `unix_chkpwd` (local accounts only, not a `jarvis-admin` PAM conversation; 3 wrong passwords lock the caller out for 5 minutes, and the helper stays running while a lockout holds); passwords never reach the model, logs or audit. Voice engines live under `/usr/lib/jarvis/voice/bin/`, and models under `/usr/share/jarvis/voice/`.

jarvisd starts its host MCP servers with the graphical session's `WAYLAND_DISPLAY`, `DISPLAY` and `XDG_CURRENT_DESKTOP`, read from `systemctl --user show-environment` (labwc's autostart imports them), and restarts them before the next turn when those change, so `jarvis-apps` and `jarvis-settings` never keep a missing or stale display (`session-env.ts`). Super+L runs `jarvis-lock` directly rather than `loginctl lock-session`, because live boots run no `jarvis-idle`; the cost is that a crashed Super+L locker is not relaunched (threat model R6). Every M3 surface is in the [threat model](../os/threat-model.md) (M25–M35, R6, R7).

See [Background daemon](../guide/background-daemon.md) for the user side.

## Remote security layers

A browser or phone reaches the core through four layers. Each is
its own module in `@jarvis/remote`, and each fails closed:

```
 device ──TLS 1.3──► Origin check ──► device token ──► owner login ──► dispatch
                     (origin.ts)      (pairing)        (owner-auth.ts)
```

1. **Device pairing** says *which device* is talking. Approving the
   laptop's dialog issues a device token, and every connection presents it
   first. Revoking a device cuts its connections and its sidecar handles.
2. **Owner login** says *that the owner is holding it*. An authenticated
   connection starts **locked** (`connection.ts`): it answers only the
   `auth:*` channels (status, password or passkey login, passkey
   registration, refresh, resume, logout), and every other request,
   subscription and upload is refused `locked`. A login unlocks it until the
   access token expires; logout, a password change or a revoked token family
   locks it again. The socket stays open, its subscriptions are dropped, and
   its sidecars are torn down.
   - The password is an scrypt hash (N=2^17, r=8, p=1) in `owner.json`
     (`owner.ts`), set only on the laptop, at least 12 characters. Without
     one the bridge does not start.
   - Passkeys are WebAuthn, browser only: the relying party is the
     certificate's DNS name and the expected origin is the web listener's.
     With either unknown, every passkey ceremony answers `unsupported`.
   - Tokens (`sessions.ts`): a 15-minute access token held in memory only,
     and a rotating refresh token that dies after 7 days unused or 30 days
     after its sign-in. Only SHA-256 hashes of refresh tokens reach
     `sessions.json`. A lost reply may be retried within 10 minutes; any
     other reuse of a retired refresh token revokes its whole family.
   - Limits (`login-limits.ts`, `owner-auth.ts`): 5 wrong passwords per
     device, then a lockout from 1 minute doubling to 1 hour; 20 failures
     across the bridge in an hour lock everyone out for 15 minutes. At most
     2 scrypt checks run at once, with 8 queued; one more is refused
     `rate-limited`.
3. **The web listener is its own origin** (`web-server.ts`). The browser
   client is served from a second TLS listener on its own port (the
   bridge's plus one, 7718 by default), because a browser treats each port
   as a separate origin: the sidecar pages proxied under `/s/<handle>/…` run
   on the bridge's origin and cannot read the web app's storage. The
   listener serves only the app's static files — `GET` or `HEAD`, exactly
   one `Host` header matching the certificate name and port, no `..` or
   encoded tricks, no upgrade — under a strict Content-Security-Policy.
   Anything else has its socket destroyed with no reply.
4. **Origin checks** (`origin.ts`) guard the bridge's `/rpc` and `/pair`
   upgrades: no `Origin` (a non-browser client), exactly the native app's
   `jarvis-app://native`, or exactly the web listener's origin while browser
   access is on. Anything else, the bridge's own origin above all, is
   destroyed before `ws` sees it. The comparison is exact, and a repeated
   header never passes. The class is checked again when the upgrade
   completes, in case the web listener closed in between.

See [Remote access](../guide/remote-access.md#owner-login) for the user
side, and [the browser client](../guide/remote-access.md#the-browser-client).

## How a feature crosses the layers

Taking the API tab's *send* as the example:

1. **renderer** (`api.ts`) collects the request and the environment's variables
   and calls `window.jarvis.sendApiRequest(project, request, variables)`.
2. **preload** forwards it over one named channel. It adds nothing.
3. **main** hands it to its `CoreClient` unchanged, and the core's dispatch
   table (`dispatch.ts`) — in-process or in `jarvisd` — validates every
   argument at the boundary, resolves the project name to a path, and
   refuses a path outside it.
4. **platform** (`http-runner.ts`) interpolates, builds and issues the request
   through an injected `fetch`.
5. The result comes back up with everything the pane needs — response,
   assertions, script output, history, cookies — in one round trip, because a
   second call for any of it would mean shipping the body back to be re-read.

The renderer names things; the core resolves them. Where the renderer must see a
real path — the API collection tree is a view of the filesystem — containment
replaces concealment: a path may be *shown*, but only a path inside the named
project is ever *acted on*.

## The phone's three networking layers

`apps/mobile` talks to the laptop through three layers, each replaceable in
tests without the other two:

1. **`modules/pinned-socket`** — the native Expo module (Swift on iOS,
   Kotlin on Android) that opens the actual TLS socket and pins it to the
   one certificate fingerprint the pairing link carried, closing before any
   frame is sent on a mismatch. It is the only layer that touches a real
   network, and the only one with no equivalent in the unit suite (see
   [testing](testing.md)).
2. **`RpcClient`** (`src/lib/rpc-client.ts`) — a state machine over the
   `Transport` interface `pinned-socket` implements: hello/welcome,
   request/response correlation with a drop-surviving queue, subscriptions
   that re-send after every reconnect, a ping watchdog, and reconnect
   backoff. It speaks `@jarvis/wire`'s frames and never touches a native
   module directly — tests drive it through `fake-transport.ts` instead.
3. **Screens and their stores** (`connection-store.ts`, `dashboard-store.ts`,
   `pairing.ts`, …) — plain TS modules that turn the client's state and
   pushes into what a screen renders, each with its own test; the `.tsx`
   files hold layout only.

`apps/mobile/src/e2e.test.ts` is the one test that drives the two non-native
layers (`RpcClient` and the screens' stores) together, end to end, for a
single pairing-to-revocation scenario. `apps/mobile/src/e2e-voice.test.ts`
does the same for a voice recording.

One path through those layers is not JSON `req`/`res` at all:

| | |
|---|---|
| The blob lane | A recording leaves `RpcClient.upload()` as a `blob` header followed by binary frames (ruling 1, M8), lands on `remote/src/connection.ts`'s own blob handling, and reaches `desktop/src/voice-turn.ts` (`handleUtterance`, shared with the desktop's own recorder) and `voice-upload.ts` (the replay-safe handler behind it) — the only two files that turn those bytes into a transcript and a routed turn. |
| The push lane | A laptop event never reaches the phone as a `req`/`res` at all: `desktop/src/notify.ts`'s `createNotifier` decides whether to notify at all (`shouldNotify`) and builds the bilingual text from `MESSAGES.push*`, and `remote-access.ts`'s `sendPush` hands it straight to `@jarvis/remote`'s Expo sender (`packages/remote/src/push.ts`) — never back down through `RpcClient`. The phone's own `RpcClient` never sees the send; it only receives the OS notification through `expo-notifications`, and on tap, `push-context.tsx`'s handler validates the session against a live `sessions:list` before navigating (M10, ruling 9). |
| An idle bridge turns itself off | The bridge's idle timer closes the listener, calls `onIdleDisabled`, and `desktop/src/remote-idle.ts` reads the current config and writes `remote.enabled: false` through `writeSettingsFile`; the queued write is then observed by `applyFromDisk`, which calls `apply` (`bridge timer → onIdleDisabled → remote-idle.ts → writeSettingsFile → applyFromDisk → apply`). |

## Plan panel

A plan — a Claude Code plan-mode scratch file, the plan a session's own
transcript last referenced, or a repo `docs/superpowers/{specs,plans}` file —
renders block-by-block in a pane beside the terminal tab instead of as raw
text. `@jarvis/core`'s `plans/blocks.ts` (`parsePlan`, `replaceBlock`) turns
markdown into `PlanBlock`s addressed by markdown-it's own line ranges, each
with a content-derived, FNV-1a-hashed id stable enough that editing one block
leaves every other block's id — and therefore its comments — untouched;
`replaceBlock` splices a single block back into the file byte-for-byte,
preserving the rest of it (CRLF, trailing newline) unchanged. `plans/comments.ts`
anchors a comment to a block by id first, falling back to a normalized
substring match of the quoted text so a comment survives most edits to the
block it was made on, and formats a set of comments into the single numbered
message the panel pastes into the terminal.

`@jarvis/platform`'s `plans.ts` (`createPlanFiles`) is the only thing that
touches disk: `list` discovers a session's plan, plan-mode scratch files and
repo specs/plans; `isAllowed` is the path guard every read and write goes
through — real-path resolved, `.md`-only, confined to the known plan-mode
directories or a `docs/superpowers/{specs,plans}` ancestry — so a remote
caller can never point a read or write at an arbitrary file; `writeBlock` is
an mtime-checked, per-file-queued, write-to-temp-then-rename update that
reports a `conflict` rather than silently clobbering a concurrent edit.
`plan-comments.ts` (`createPlanCommentStore`) is a separate JSON store at
`~/.config/jarvis/plan-comments.json`, following the bookmark store's own
corrupt-file-preserving, atomic-write shape. On the desktop side, `plans:*`
IPC (`channels.ts`, `dispatch.ts`) sits behind the same remote-policy table as
every other tab, and `plans:send` pastes `formatFeedback`'s message into the
pane through a bracketed-paste helper (`bracketed.ts`) that strips control
bytes — plan text and comment bodies are file/user content the terminal does
not otherwise trust as input. `apps/mobile` reaches the same surface over the
wire (`lib/plans-store.ts`, `src/plan/*`), so a paired phone gets read,
comment and send parity with the desktop panel, never a reduced view of it.

| Channel | Remote |
|---|---|
| `plans:list`, `plans:read`, `plans:writeBlock`, `plans:comments`, `plans:addComment`, `plans:updateComment`, `plans:deleteComment`, `plans:send` | remote — the same content parity this table gives sessions/git/bookmarks; each path is re-checked against `PlanFiles.isAllowed` in the handler regardless of origin, so this only decides whether a phone may call the channel at all |
| `plans:openLink` | desktop-only — runs Electron's `shell.openExternal` on the laptop; a paired phone opens a plan's links with its own OS |
## Phone and wide layouts

The same `apps/mobile` code serves a phone, a tablet and a desktop browser
(the web export the laptop's web listener serves). One pure function picks
the shell:

- **`layoutClassFor({ width, height })`** (`src/lib/layout-class.ts`)
  answers `wide` when **width ≥ 744 and the shortest side ≥ 600**, and
  `phone` otherwise. 744 is the iPad mini's portrait width; the short-side
  rule keeps a landscape phone (e.g. 915×412) on the phone layout. A wide
  window under 900 is `compact`, which drops the top bar's metrics readout,
  as the desktop's own top bar does. `useLayoutClass()` feeds it the live
  window size, so rotation and resize re-evaluate without a reload.
- **`WideShell`** (`src/components/WideShell.tsx`) wraps the one `Tabs`
  navigator in `app/(tabs)/_layout.tsx` on both classes. On a wide screen it
  draws a desktop-style top bar (brand, nav, metrics, "N running", the
  connection pill, a clock) and the navigator's bottom bar is hidden. The
  wrapper tree is the same either way, so crossing the breakpoint keeps the
  route and never remounts the screens — an open terminal keeps its pty.
  The bar's logic (nav order, which section a route belongs to, the pill
  counts) is `src/lib/wide-shell-model.ts`, unit tested with no renderer.
- **Content components live in `src/screens/`** (`SessionDetail`,
  `TerminalPane`, `WorkspaceTools`, `SettingsSections`, `DashboardPanels`,
  `ApiScreen`, `DockerScreen`, `ChangesScreen`). Each owns its data and UI;
  the routes under `app/` are thin wrappers that render it full screen on a
  phone or inline in a panel on a wide screen. Selection lives in URL search
  params (`/sessions?id=<id>`, `/workspace?tab=<tabId>`), so no route
  changes between layouts, and `/session/<id>` on a wide screen redirects
  to the split view.
- **RTL uses `direction`, never `row-reverse`.** The top bar and the split
  panes set `direction: "rtl"` in Arabic, and a `flexDirection: "row"`
  container then puts its first child on the reading-start side on native
  and web alike (`session-nav.ts`'s `splitLayout`). A reversed row would
  flip twice on native, where `I18nManager` has already forced RTL for
  Arabic; on web, where react-native-web ignores `forceRTL`, `direction` is
  the only thing doing the mirroring.

## Third-party components

| | | |
|---|---|---|
| `@xterm/*` | terminal emulation | vendored into `renderer/vendor/`, copied to `dist/` by a script so it satisfies the renderer's `script-src 'self'` CSP |
| `node-pty` | real ptys | native module; shared by agent sessions and Terminal tabs |
| `@usebruno/lang` | `.bru` parse and serialise | pinned exactly — a byte-identical round trip is what the API tab's file format rests on |
| `undici` | http | used explicitly because Node's global `fetch` cannot express a proxy or relaxed TLS |
| `systeminformation` | machine metrics | |
| `code-server`, `dbgate-serve` | Editor and Database tabs | spawned, never linked; installed by the user |
| `headlamp-server` | Cluster tab | spawned, never linked; installed by the user |

### Electron for Content Security, and Widevine

Jarvis does not run on stock Electron. It runs on
[castlabs/electron-releases](https://github.com/castlabs/electron-releases) —
"Electron for Content Security" — which is Electron plus Google's **Widevine
Content Decryption Module**. That is what lets the Personal browser play
protected video; stock Electron plays none.

Two consequences worth stating plainly, because neither is implied by this
repository's MIT licence:

- **The Widevine CDM is proprietary software owned by Google**, distributed
  under its own terms. It is not covered by the MIT licence above, and MIT
  says nothing about your right to redistribute it.
- **A build that plays DRM must be VMP-signed** by castLabs' EVS service,
  which issues credentials per account. `scripts/vmp-sign.cjs` does this at
  package time. Without those credentials the build still works — it simply
  plays no DRM, and says so loudly during packaging.

Anyone redistributing a packaged Jarvis should read castLabs' terms for
themselves. Building and running it for your own use raises none of this;
publishing binaries that embed the CDM does.

To build on stock Electron instead, replace the `electron` dependency in
`packages/desktop/package.json` and drop the `electronDist`, `electronVersion`
and `afterPack` keys from `electron-builder.yml`. Everything except DRM
playback behaves identically.

### Rafiq M4: backup brain, Arabic, recipes (jarvisd)

- **Backup brain.** `failover.ts` ends the provider chain with the catalog's backup model (`/usr/share/jarvis/models/catalog.json`, the one `role: "backup"` entry) on the fixed loopback Ollama. Any failure of the configured providers before a first event — network, auth, 4xx, nothing configured — moves the turn there; `provider:status` says `activeId: "backup"` and why. On the backup the tool loop offers and allows only the 19 simple tools (`backup.ts`) and stops after 8 steps; the first backup reply of a turn starts with a one-line notice. When Ollama lacks the backup model it counts as unreachable, so the shell still offers the network doctor.
- **Languages.** `i18n.ts` decides the UI language (`os.language`, else `LANGUAGE`/`LANG`) and a turn's language (the prompt's, when it is clearly the other language). `messages.ts` keeps every user-visible string in `{en, ar}` tables; tsc refuses a missing key and `i18n-tables.test.ts` refuses empty or untranslated cells. Model-facing text stays English; the model is told which language to answer in. `jarvis.describe` gets `lang: "ar"` for Arabic turns (and is asked again without it by an older server). `ui:setLanguage` writes `os.language` and pushes `ui:language`.
- **Recipes.** `recipes.run {id}` (card input `{id, items: [stepIndex]}`, batch on `items`) never reaches a server: `recipe-engine.ts` reads the recipe from `/usr/share/jarvis/recipes/`, checks the machine and each step tool (only `pkg.install`, `svc.restart`, `apps.set_default` from a built-in server, never password-tier), shows ONE card with an item per step, then runs the ticked steps in order through the registry and stops at the first failure. Each step is audited with its own result. Non-executing `note` steps are displayed on the card; Docker group membership remains a plain instruction. `requires.os` uses `/etc/os-release` ID, and `minRamGB` accepts at least 90% of the stated GiB.

### Rafiq v1.1: computer use (jarvisd)

- **When.** The `screen.*` tools (`screen-tools.ts`) are offered only when `os.computerUse.enabled[<provider>]` is true, the provider's model sees images (`vision.ts`: the catalog's `vision: true` tags, else a conservative model table) and, for any non-loopback provider (including LAN), `os.computerUse.cloudConsent[<provider>]` exists. Never in the read-only profile, while locked, or for a phone-origin turn. All of it is asked again before every screen call, so a failover mid-turn ends the session.
- **Session.** The first `screen.look {goal, apps}` shows ONE card (`cu.begin`, "Let Jarvis use <apps> to: <goal>", approved on the computer only) and calls jarvis-cu `begin`. Actions then run without cards, except consequential ones (`consequential.ts`: declared intent, save/delete/send shortcuts, en/ar accessibility labels from `describeAt`, rather than model-supplied target text), which get their own card first. 50 actions at most; five identical screenshots in a row end the session as stuck; a `paused` push pauses it (`cu:resume` re-arms with `begin`), `locked` ends it, and every turn end ends it. `cu:state` mirrors it all for the shell and is re-pushed on every new control connection, including the idle state. Active sessions raise the turn step cap to 110 to leave room for 50 screen actions plus overhead.
- **Screenshots.** At `begin`, jarvis-cu makes one allowed window fullscreen. It captures that window only while fullscreen and focused; otherwise the whole frame is black. Other windows have empty titles and zero rectangles (contracts §4). The image goes to the model as an image block (`images.ts` + each adapter); only the newest one is ever in a request, `withImagePolicy` withholds it from any provider that may not see the screen, and history, memory, logs and `audit.jsonl` never hold one. Allowed-window titles reach the model inside the untrusted fence and the safety rules say screen text is data.
- **Helper.** `cu-client.ts` speaks NDJSON to `$XDG_RUNTIME_DIR/jarvis/cu.sock` only after the kernel names `/usr/libexec/jarvis/jarvis-cu` as the peer (the M3 sock_diag check). Coordinates, keys and text are limited in jarvisd too (`screen-tools.ts`), and jarvis-cu enforces its own allowed-window and excluded-surface rules. `apps` lists running app IDs and names before a session; `describeAt` supplies accessibility labels for consequence checks.
- **Verification.** `cu.e2e.test.ts` exercises approval cards, successful and excluded clicks, settings channels, state pushes and screenshot-free audit over the real control socket with a fake helper. `cu-client.labwc.test.ts` is Linux-only and opt-in (`JARVIS_CU_LABWC=1`); `packages/desktop/scripts/cu-headless-test.sh` runs it against the real helper in headless labwc after Plan U is available. Fullscreen capture makes only coordinates beyond the capture outside; excluded surfaces inside it remain refused.
