# Conventions

Rules this codebase actually enforces. Each exists because of something that
went wrong, and most have a test guarding them.

## Every user-visible string is bilingual

`MESSAGES` in `packages/desktop/src/messages.ts` takes a language and returns a
string. The user's primary language is Arabic; a second, English-only lane of
strings beside the bilingual table was a real regression once and is the thing
this rule prevents.

Counted nouns get their own function rather than a template with a number
dropped in: Arabic has distinct singular, dual and plural forms, and the dual
differs by grammatical case — which is why `arabicFilesCount` and
`arabicSessionsCount` are separate tables that look identical.

## No `innerHTML` in the renderer

Every node is built and its text set with `textContent`. Page titles, agent
output, file paths and project names are all attacker-influenced text arriving
in the process that holds `window.jarvis`.

## The renderer imports only types from workspace packages

See [architecture](architecture.md). Guarded by `no-value-imports.test.ts`.

## `$(id)` is a contract with the markup

`id-contract.test.ts` derives the id list from the source of each renderer
module and checks `index.html` has them all. A typo is invisible to `tsc` and
would otherwise surface as a blank route at runtime.

## Settings fields commit on `change`, never on `input`

The Settings and API editors re-render wholesale on every mutation. Committing
per keystroke would steal focus mid-word.

## Injected dependencies, always

`createCodeServerManager`, `createDbGateManager`, `createShellManager`,
`sendRequest`, every IPC handler factory: the side effect is a parameter. This
is why "one instance per project", "reuse", "kill on quit" and "refuse a path
outside the project" are all unit tested with no real process, port or file.

## The renderer measures in CSS pixels; a view is placed in DIP

`getBoundingClientRect` answers in CSS pixels. `WebContentsView.setBounds`
takes device-independent pixels. They are the same size only while the display
runs unscaled — on a scaled one, `devicePixelRatio` is not the display's
`scaleFactor` and the two diverge. A rectangle handed straight across left
every hosted page 9% short of its slot.

So the renderer reports its rectangle *and* the `devicePixelRatio` it measured
under, and main converts (`view-bounds.ts`). Never call `setBounds` with a
number that came from the DOM without converting it.

The conversion is deliberately not derived from the window's own geometry:
`getContentBounds()` reports the whole display in full screen while the web
contents sits inset below the menu bar, so a ratio computed that way disagrees
between the two axes and pushes the view past the bottom of the window.

## Comments say why, not what

The codebase is dense with comments that record a decision and the failure that
prompted it. When you change such a line, the comment is part of what you are
changing.

## A function whose behaviour differs by OS takes the platform as a parameter

`defaultHeadlampBinary(platform, env)` is the pattern. Only `main.ts` and
`preload.cts` read `process.platform`; everything downstream receives it.

This is not tidiness. There is no CI and one laptop, so a function that reads
`process.platform` at the point of use can only ever be tested on the OS the
test happens to run on — and the whole Linux port would then be asserted by
nothing. Parametrised, one `pnpm test` proves both.

The rule is why `parseHeadlamp` returns `undefined` for an absent
`headlamp.binary` rather than the per-OS default it used to: config parsing
knows nothing about the host, and `main.ts` fills the default in at the edge.

Guarded by `platform-convention.test.ts`.

## No `webContents.send` outside `broadcast.ts`

Renderer pushes go through `desktop/src/broadcast.ts`. It is the single
boundary that calls `webContents.send`; producers hand it typed payloads
instead. The source guard keeps a new direct send from bypassing the
broadcaster's window-destroyed check and centralised push wiring.

## A new invoke channel is written down in every table

A new invoke channel is written down in the `RendererApi` method, the
`INVOKE_CHANNELS` method-to-wire map, `CHANNEL_POLICY`, `REMOTE_EFFECT`, and
the dispatch table. `REMOTE_EFFECT` holds only remote-access channels: a
desktop-only channel must not be added. It is the fourth place that classifies
a remote channel, recording whether the call is a read, a mutation or an
input stream for audit purposes, in parallel with the access decision in
`CHANNEL_POLICY`; its `satisfies Record<RemoteChannel, …>` check makes
omissions compile-time failures. The dispatch table is where the handler is
actually selected. The relevant guard tests are `no-direct-send.test.ts`,
`i18n.test.ts` and `messages.test.ts`.

## Package direction is an allowlist

`@jarvis/remote` may import `node:*`, `@jarvis/wire`, `@jarvis/core`, relative
imports inside `src/`, and the per-file third-party table enforced by
`packages/remote/src/import-direction.test.ts`: `ws` in `server.ts` and
`probe-client.ts`, and `@peculiar/x509` plus `reflect-metadata` in
`certificate.ts`. In particular it does not import `platform`, `desktop` or
Electron. The only workspace package `remote` imports is `@jarvis/wire`;
`@jarvis/core` is allowed by the per-file test but not currently imported.
`wire` has no `node:*` imports,
and the phone imports `@jarvis/wire` plus type-only `@jarvis/core`.

## Parse wire values field by field

Every wire value is parsed field by field; never spread input. A parser picks
the exact fields and validates their types, bounds and allowed strings before
building the internal value. Unknown or attacker-controlled properties do not
become internal options merely because they were present on a decoded object.

## Secrets and content never enter logs

Tokens, secrets, output and bodies are never logged or audited. Remote audit
lines carry only bounded identifiers and outcome words: a mutating channel,
an input channel's first key per connection, a refused probe, or a queued push
kind. They do not carry a token, pairing secret, argument, path, command,
terminal bytes, response, transcript or message body.

## Phone and laptop copy have separate homes

Phone strings live in `apps/mobile/src/lib/i18n.ts`; laptop strings live in
`packages/desktop/src/messages.ts`. Both languages must be present and `ar`
must differ from `en` for every new string. A phone screen does not borrow a
laptop string or hard-code English into a component.

## No left/right styles on the phone

Phone layout uses RTL-aware `start`/`end` and direction-aware content. Do not
add left/right styles to the phone screens; `rtl-lint.test.ts` checks the app
and component sources for those physical-direction properties. Terminal,
diff, cURL and response content may deliberately opt into LTR as content, not
as a shortcut for laying out the surrounding phone UI.
