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
