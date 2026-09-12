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
