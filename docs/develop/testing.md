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

**jsdom is not a browser, and Electron is not jsdom.** `window.prompt` exists
in jsdom and throws in Electron. Every create and rename in the API tab did
nothing for a while, with 1581 tests green.

**A fake `fetch` accepts anything.** A multipart body built from the wrong
realm's `FormData` was silently stringified; the tests passed because the fake
recorded whatever it was handed. Real servers found it.

**A green assertion may never have run.** `expect(x).to.be.true` is a *getter*
in chai. Implemented as a function it is read, never called, and always passes.

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
