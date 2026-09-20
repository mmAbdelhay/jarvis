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

## Two platforms

macOS and Linux, and the rule that keeps them one codebase: **a function whose
behaviour differs by OS takes the platform as a parameter**. Only `main.ts`
and `preload.cts` read `process.platform`; the renderer receives it over the
bridge as `window.jarvis.platform`. `platform-convention.test.ts` enforces it.

There is no CI and one laptop, so this is not tidiness — a function that reads
`process.platform` at the point of use can only be tested on the OS the test
happens to run on, and half the app would be asserted by nothing. See
[conventions](conventions.md).

The places that actually differ are few, and each is a named function with
both branches tested:

| Concern | Module |
|---|---|
| Shell integration | `platform/zsh-integration.ts`, `bash-integration.ts`, dispatched by `shell-integration.ts` |
| Which shell, and how it is started | `platform/shell.ts` — `shellCommand`, `shellArgs` |
| History format | `platform/completion.ts` — `parseZshHistory`, `parseBashHistory` |
| Microphone | `desktop/recorder.ts` — `recorderCommand` |
| Audio playback | `platform/piper.ts` — `audioPlayer` |
| Speech routing | `platform/piper.ts` — `RoutedSpeech`, `silentSpeech` |
| Keyboard chords and their labels | `desktop/renderer/keys.ts` |
| Application menu | `desktop/app-menu.ts` |
| Sidecar default paths | `platform/headlamp.ts` — `defaultHeadlampBinary` |

## Inside `desktop`

```
src/main.ts          composes everything, owns the window, registers IPC
src/ipc.ts           every handler, as pure functions over injected deps
src/preload.cts      the only bridge; contextIsolation is on
src/browser-host.ts  the Workspace's tabs, Electron-free and unit tested
src/electron-view.ts the one file that constructs a WebContentsView
src/sidecar-reaper.ts when a sidecar nobody is looking at should be stopped
src/remote-idle.ts  main-process write-back after the bridge's idle timer fires
src/remote-access.ts the request, push and audit lane between main and remote
renderer/            the UI. No Node. Type-only imports from the packages.
```

**`browser-host.ts` contains no Electron import.** Tab lifecycle — partitions,
eviction, visibility, suspension, which tab is active — is ordinary logic, and
keeping Electron behind `ViewFactory` is what lets all of it run in plain
Vitest. `electron-view.ts` is the only place a view is constructed.

**Suspension is the host destroying a view and keeping its tab.**
`sweepIdle()` — driven by a once-a-minute timer in `main.ts` — destroys the
`HostedView` behind any tab that has sat hidden past
`performance.suspendTabsAfterMinutes` and marks the tab `suspended`. The row
in `TabStore` is untouched, so nothing about the tab strip changes; `activate`
sees the flag and builds a new view before showing it.

This is tab suspension; it is separate from the remote bridge's idle
auto-disable, which closes the listener when no paired phone is connected and
no pairing activity is keeping it open.

Rebuilding needs one thing the host cannot know. A hosted app's sidecar may
have been stopped underneath it and restarted on a different free port, so the
address the tab was suspended holding points at nothing. `resumeUrl` is
injected for exactly that: `main.ts` routes the answer through the same
handler the tab's own button uses, so "reuse if running, start if not" is
decided in one place.

**Stopping a sidecar is decided outside the managers.** Nothing calls
`CodeServerManager.open()` again while you type in the editor, so a "last
used" stamp kept manager-side goes stale on the instance actually in use.
Only the workspace's tabs know what is needed, so `main.ts` computes that set
each sweep and `sidecar-reaper.ts` holds the grace period over it; the
managers only learn `stop(key)` and `runningKeys()`. `codeServerKey` is
exported and shared because the reaper builds its keys from config, from the
other end entirely.

**The renderer may import only *types*** from a workspace package. A value
import is a bare specifier that survives compilation and 404s at runtime in the
bundle; `no-value-imports.test.ts` enforces it, and it exists because that
mistake was made.

## How a feature crosses the layers

Taking the API tab's *send* as the example:

1. **renderer** (`api.ts`) collects the request and the environment's variables
   and calls `window.jarvis.sendApiRequest(project, request, variables)`.
2. **preload** forwards it over one named channel. It adds nothing.
3. **main** validates every argument at the boundary, resolves the project name
   to a path, and refuses a path outside it.
4. **platform** (`http-runner.ts`) interpolates, builds and issues the request
   through an injected `fetch`.
5. The result comes back up with everything the pane needs — response,
   assertions, script output, history, cookies — in one round trip, because a
   second call for any of it would mean shipping the body back to be re-read.

The renderer names things; main resolves them. Where the renderer must see a
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
