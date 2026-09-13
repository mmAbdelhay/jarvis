# Contributing

Jarvis is one person's tool that other people can now read. Issues, questions
and pull requests are all welcome; none of them is expected.

## Before you open a pull request

Nobody can push to `master`. Every change arrives as a pull request, and CI has
to be green before it can merge. CI runs exactly four commands, on Linux, macOS
and Windows, and you can run all four yourself:

```bash
pnpm lint        # Biome: formatting and rules, warnings included
pnpm typecheck   # tsc -b across the workspace
pnpm build       # emits dist/ and copies the vendored xterm beside it
pnpm test        # vitest, ~3,500 tests
```

`pnpm lint:fix` applies everything Biome can fix on its own, and `pnpm format`
reformats without touching rules. Run `pnpm build` before `pnpm test` on a
fresh clone: one test reads the emitted `dist/` and fails on a tree that was
never built.

## Getting it running

**[SETUP.md](SETUP.md)** is the whole path on a new machine. The short version:

```bash
pnpm install
pnpm bootstrap                           # fetches Electron, builds node-pty
pnpm --filter @jarvis/desktop start
```

`pnpm bootstrap` is not optional — see the comment at the top of
`pnpm-workspace.yaml` for what it does and why the install script that would
normally do it is suppressed. You need **Node 24 or newer**: the session store
is built on `node:sqlite`, which Node 22 does not have.

## How the code is written

- **[docs/develop/conventions.md](docs/develop/conventions.md)** is the one to
  read first. Every user-visible string is bilingual, the renderer never
  touches `innerHTML`, dependencies are injected rather than imported, and a
  function whose behaviour differs by OS takes the platform as a parameter
  instead of reading `process.platform`.
- **[docs/develop/architecture.md](docs/develop/architecture.md)** explains the
  packages and how a feature crosses them.
- **[docs/develop/testing.md](docs/develop/testing.md)** says what is tested
  where, what the doubles stand in for, and what tests here cannot see.
- **[docs/develop/adding-a-tab.md](docs/develop/adding-a-tab.md)** covers the
  three shapes a Workspace tab comes in.

Comments say why, not what. A comment that restates the line below it will be
asked about in review.

## Commits

Conventional Commits, lowercase, with the scope where there is an obvious one:

```
fix(voice): give piper its text on stdin — there is no input-file flag
feat(terminal): install bash integration and read bash history
docs: cover Linux everywhere the guides assumed macOS
```

The subject says what changed. The body says why it needed to, and what else
was considered — that is the part worth writing.

## Tests

New behaviour comes with a test. The suite is fast and runs entirely offline;
nothing in it spawns a real agent, opens a real pty, or reaches the network. If
what you are changing seems untestable, say so in the pull request — that is
usually a seam that wants injecting rather than a thing that cannot be tested.

## Reporting a bug

Open an issue. What helps most: your OS and `node --version`, what you expected,
what happened, and anything the terminal printed. If it involves an agent, name
which one — Jarvis drives several and they behave differently.

For anything security-related, please read [SECURITY.md](SECURITY.md) instead of
opening a public issue.
