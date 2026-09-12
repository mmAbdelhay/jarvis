# Architecture

Three packages in a pnpm workspace, and the direction of every import between
them is the whole design.

```
@jarvis/core        pure logic. No Node, no Electron, no filesystem.
      ▲
@jarvis/platform    the machine: processes, ptys, sqlite, git, http, files.
      ▲
@jarvis/desktop     Electron. main process + preload + renderer.
```

`core` knows nothing about the world it runs in, which is what makes the
orchestrator, the tab store and the URL rules testable without mocking an
operating system. `platform` is where every side effect lives, always behind an
injected dependency so the orchestration around it can be tested with a fake.
`desktop` composes the two and adds the window.

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
