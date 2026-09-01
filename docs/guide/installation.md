# Installation

## What Jarvis needs to start

- **Node 22 or newer** and **pnpm 10**. The repository pins pnpm in
  `package.json`; `corepack enable` is enough to get the right one.
- **macOS.** Jarvis runs elsewhere in principle — nothing in it is
  deliberately Apple-only except the dock icon and the Whisper defaults — but
  it has only ever been run on macOS, and the disk metric knows about APFS
  specifically.

```bash
pnpm install
pnpm --filter @jarvis/desktop start
```

The first run reads `~/.config/jarvis/jarvis.yaml`. If there is no such file,
Jarvis starts with defaults and the Settings route is the quickest way to
write one.

## What each optional tool unlocks

Jarvis works without all of these; each one is missing only the feature it
belongs to, and the feature says so rather than failing quietly.

| Tool | Unlocks | Install |
|---|---|---|
| A coding agent CLI (`claude`, `copilot`, …) | Sessions — the point of the app | per that tool |
| `code-server` | The **Editor** tab | `brew install code-server` |
| `dbgate-serve` | The **Database** tab | `npm i -g dbgate-serve` |
| `whisper-cli` + a model | Voice input | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) |

The **Terminal** and **API** tabs need nothing installed: the terminal is a
pty Jarvis spawns itself, and the API client issues its requests from the main
process.

### Voice

Voice is off unless `whisper.binaryPath` and `whisper.modelPath` both point at
files that exist. The default model is `large-v3-turbo` rather than `base`, and
that is deliberate: `base` mis-transcribes Arabic project names badly enough to
break routing, which decides *which agent* hears an instruction.

## Verifying the install

```bash
pnpm test        # the whole suite, no network required
pnpm typecheck
```

A green suite says the code is sound; it says nothing about whether the
external tools above are present. Those show up the first time you click the
tab that needs one.
