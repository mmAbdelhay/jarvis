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

The first run reads `~/.config/jarvis/jarvis.yaml`. **There must be one**: with
no config file Jarvis shows "Jarvis failed to start" and quits, because a
sensible default for "which agent runs your code" does not exist. The smallest
file that works declares one agent and an empty brain — see
**[SETUP.md](../../SETUP.md)** for it, and [configuration](configuration.md)
for everything else.

## What each optional tool unlocks

Jarvis works without all of these; each one is missing only the feature it
belongs to, and the feature says so rather than failing quietly.

| Tool | Unlocks | Install |
|---|---|---|
| A coding agent CLI (`claude`, `copilot`, …) | Sessions — the point of the app | per that tool |
| `code-server` | The **Editor** tab | `brew install code-server` |
| `dbgate-serve` | The **Database** tab | `npm i -g dbgate-serve` |
| `headlamp-server` | The **Cluster** tab | `brew install --cask headlamp` (macOS) |
| `whisper-cli` + a model | Voice input | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) |

The **Terminal** and **API** tabs need nothing installed: the terminal is a
pty Jarvis spawns itself, and the API client issues its requests from the main
process.

`headlamp-server` is not distributed on its own — it ships inside the
Headlamp desktop app bundle, at `resources/headlamp-server` relative to the
install root on every platform. Jarvis looks for it at the default location
for the OS it is running on:

| Platform | Default path |
|---|---|
| macOS | `/Applications/Headlamp.app/Contents/Resources/headlamp-server` |
| Windows | `%LOCALAPPDATA%\Programs\Headlamp\resources\headlamp-server.exe` |
| Linux | `/opt/Headlamp/resources/headlamp-server` |

`headlamp.binary` in `jarvis.yaml` (see [configuration](configuration.md))
overrides this when Headlamp is installed somewhere else.

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
