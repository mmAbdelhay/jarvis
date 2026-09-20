# Testing

```bash
pnpm test          # everything
pnpm typecheck     # tsc -b across the workspace
```

Vitest, in two environments: plain Node for `core` and `platform`, jsdom for
the renderer (declared per file with `// @vitest-environment jsdom`).

## What is tested where

| | |
|---|---|
| `core` | pure logic — the orchestrator, tab store, URL normalisation |
| `platform` | orchestration around a side effect, with the side effect faked: managers, the http runner, `.bru` read/write, assertions, cookies |
| `desktop/src` | IPC handlers over fake deps; `browser-host` with a fake view factory |
| `desktop/renderer` | jsdom: what the DOM ends up saying, what reaches `window.jarvis` |

Guard tests that are not about behaviour: `id-contract`, `no-value-imports`,
`dist-emit-resolution`, `route-nesting`, `view-display-css`, and the markup
tests. Each pins something a type checker cannot see.

## Doubles

xterm.js renders to a canvas and measures real character cells, neither of
which jsdom has. `renderer/terminal-double.ts` stands in for it, and the files
that mock the vendored modules must agree on its shape.

## What tests cannot see

This is the part worth reading, because most of the bugs found late in this
codebase were found *outside* the suite.

**The platform half of the suite is asserted, but not exercised.** Every
OS-dependent function takes the platform as a parameter, so `pnpm test` proves
both spellings of every chord and both shells' wrappers from one machine —
what it cannot prove is that either actually behaves that way on the other OS.
The list below is the manual pass, and every item on it caught something a
green suite did not:

- A real bash under a real pty, emitting OSC 133 with blocks, the file sidebar
  and the chips following it. Two ordering bugs lived here: the wrapper's own
  setup lines tripped the DEBUG trap, and bash-preexec — which several tools
  install — clobbered the trap and swallowed the first command of a session.
- An AppImage launched from outside the repo on a clean machine. Running from
  the repo picks up files the bundle does not contain.
- `node-pty` loading from inside `app.asar.unpacked`. It is the load-bearing
  native module and the one thing asar can break.
- The hotkey under Wayland against X11.
- DRM playback in the Personal browser.
- Recording through PulseAudio and through PipeWire's shim.
- That every formula, cask, winget id and release asset in the prerequisite
  catalogue still resolves upstream. The suite proves the catalogue's shape —
  that nothing runnable needs root, that every tool has a detection, that a
  voice downloads both its files — and can prove nothing about whether
  `brew install whisper-cpp` still names a real formula a year from now.
- The sidecar reverse proxy (M11) against a real WebView. `proxy-rewrite.test.ts`
  and `proxy.integration.test.ts` (the latter a real loopback HTTP target
  behind the real TLS listener, `@jarvis/remote`'s second real-network test
  file after `bridge.integration.test.ts`) prove the proxy's rewriting,
  cookies and upgrades; they cannot prove that `react-native-webview` on a
  real device actually renders code-server, keeps a terminal's WebSocket
  open, or refuses to leave the sidecar's origin — `apps/mobile/README.md`'s
  manual-pass checklist covers that. Headlamp under the proxy's path prefix
  specifically is untested even manually in this codebase's own development
  — `headlamp-server` was never installed on the machine this milestone was
  built on — so it is a recorded open item rather than a verified path; see
  the manual pass for what to do if its assets turn out to need it. Two more
  gaps worth naming rather than rediscovering: the listener's 5 s
  `requestTimeout` bounds a proxied request's *body* only — a multi-second
  upload through the proxy (a DbGate import, say) is cut at 5 s, while
  responses, SSE and upgrades are unaffected, which is expected and not a
  proxy bug; and `/s/…` while the proxy is unavailable, at the real TLS
  listener, is exercised only by the double-based `server.test.ts` —
  `proxy.integration.test.ts` always wires up a real proxy, so that one path
  is unit-covered rather than integration-covered.

**jsdom is not a browser, and Electron is not jsdom.** `window.prompt` exists
in jsdom and throws in Electron. Every create and rename in the API tab did
nothing for a while, with 1581 tests green.

**A fake `fetch` accepts anything.** A multipart body built from the wrong
realm's `FormData` was silently stringified; the tests passed because the fake
recorded whatever it was handed. Real servers found it.

**A green assertion may never have run.** `expect(x).to.be.true` is a *getter*
in chai. Implemented as a function it is read, never called, and always passes.

**A check can compare two wrong things and pass.** "Does the hosted view fill
its slot?" was answered by comparing the view's `innerWidth` against the slot's
CSS width. Both are CSS pixels — but of two differently scaled frames, so the
numbers matched while the page was visibly 9% short of the window. The check
that finds it compares the view against the **window in device-independent
pixels**. When a measurement confirms what you expected, confirm it is
measuring in the units you think it is.

**A screenshot of the desktop is not a screenshot of the app.** More than one
Electron instance may be running — a stale one from an earlier build, another
agent's — and the frontmost window is whichever the OS says. Capture through
the app's own CDP target, or check geometry numerically.

The suite also cannot see an idle timer against a wall clock; the audit file
on a real disk across a rotation; a phone's `AppState` transitions on a
device; `terminate()` against a real WebSocket peer; or whisper's real
stderr. Those boundaries stay in the manual pass because the doubles prove
the state-machine decisions without proving the operating system's timing,
filesystem, native lifecycle, socket or decoder behaviour.

**`apps/mobile` has its own suite, and its own blind spots.** It runs under
plain Node (`PATH=/opt/homebrew/bin:$PATH npx vitest run --config
apps/mobile/vitest.config.mts`), separately from the root suite above — no
real network, no native modules and no React Native renderer, by rule.
`FakeTransport` stands in for the socket, an injected `Clock` for every
timer, and an in-memory `SecureStore` for the keychain; `e2e.test.ts` scripts
one pairing-to-revocation run across the real `RpcClient`, connection store
and dashboard store together. `e2e-session.test.ts` drives the real session stores and input controller through attach, snapshot/push deduplication, gap markers, raw keys, reconnect without input replay, session completion and subscription cleanup. What that suite cannot see:

- **Certificate pinning itself.** `modules/pinned-socket`'s Swift and Kotlin
  compare a SHA-256 fingerprint against the presented leaf; nothing in the
  JS suite ever runs that code; it needs a device or simulator and a real
  TLS handshake with a mismatching certificate (`apps/mobile/README.md`'s
  manual-pass checklist).
- **RTL rendering.** `I18nManager.forceRTL` and the resulting mirrored
  layout are asserted at the source level only — `rtl-lint.test.ts` greps
  every `app/` and `src/components/` file for a hard-coded left/right style
  (`marginLeft`, `right:`, …) rather than `start`/`end` — but never
  rendered — there is no RN renderer in the suite, so a screen that greps
  clean but still looks wrong under RTL would not be caught here.
- **The terminal WebView.** Tests pin the generated page, CSP script hash, navigation gate and per-load ready-message guard, but cannot render xterm inside Android/iOS WebView. Terminal sizing, background/resume, renderer crashes, IME input and real accessibility require the session checks in `apps/mobile/README.md`.
- **The camera.** `expo-camera`'s scanner is exercised nowhere in the unit
  suite; the pairing screen's own logic is tested with a fake decode
  result, never a real frame.
- **Voice.** `e2e-voice.test.ts` drives the real `RpcClient` and
  `VoiceController` through record, upload, a spoken reply, a mid-upload
  drop and a retry — but the recorder, the speaker and the recording file
  are all fakes, and `remote-voice.integration.test.ts` fakes whisper on
  the laptop side too. Untested by either suite: real phone recordings on
  each OS, whisper's actual transcription accuracy, the OS's own speech
  voices, the iOS audio-route switch between the earpiece and the
  loudspeaker, and the native `sendBinary` implementations that actually
  put bytes on the wire — all manual-pass only (`apps/mobile/README.md`).
- **Push notifications.** `e2e-push.test.ts` drives the real
  `createPushRegistration` and the pieces `push-context.tsx`'s own tap
  handler composes (`waitForOpen`, `recordHandledId`, `planNavigation`,
  `parseSessionList`) over a real `RpcClient`, and
  `remote-push.integration.test.ts` drives the laptop side the same way
  `remote-voice.integration.test.ts` does, with a recording `fetch` standing
  in for Expo's own HTTP API. Neither suite can see: real APNs/FCM delivery,
  the OS's own permission prompts (and their "denied" vs "denied
  permanently" split), Expo's receipt timing (`RECEIPT_DELAY_MS` is 15
  minutes; nothing here waits that long), the Android notification channel's
  actual appearance, token rotation on a real device, or the credentials
  (`eas credentials`) configured on EAS — all manual-pass only
  (`apps/mobile/README.md`).
- Everything the desktop side's blind spots above already name — a real
  socket close code arriving from a real TLS stack, an app actually
  backgrounded and resumed, a phone on a real LAN reaching a real laptop —
  applies here too, per the manual pass.

So: for anything that touches a real boundary, drive the built app or send a
real request.

```bash
# drive the running app
pnpm --filter @jarvis/desktop build
npx electron packages/desktop --remote-debugging-port=9222
# then talk to http://127.0.0.1:9222/json/list over CDP
```

A short script that clicks through the UI and reads the DOM back has caught
more real defects here than any amount of additional unit testing would have.

Two practical notes. Match the CDP target on `renderer/index.html`, not
`index.html` — a page the test itself serves may well be at `/index.html` and
will be matched instead. And kill only what you started (`pkill -f
"remote-debugging-port=<yours>"`): a bare `pkill -f electron` takes down every
other Electron app on the machine.
