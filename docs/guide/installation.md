# Installation

## What Jarvis needs to start

- **Node 22 or newer** and **pnpm 10**. The repository pins pnpm in
  `package.json`; `corepack enable` is enough to get the right one.
- **macOS (Apple Silicon) or Linux (x64).** Both are built and run; neither is
  a port of the other. Windows is not a target.
- **On Linux, a C++ toolchain and Python** — `build-essential` and `python3`
  on Debian and Ubuntu, `gcc-c++ make python3` on Fedora, `base-devel python`
  on Arch. node-pty ships prebuilt binaries for macOS and Windows only, so on
  Linux its native binding is compiled once, by `pnpm bootstrap`. Every agent
  session and every Terminal tab is a pty; without it nothing runs.

```bash
pnpm install
pnpm bootstrap
pnpm --filter @jarvis/desktop start
```

`pnpm bootstrap` is a required step, not a convenience. This workspace runs
with install scripts disabled deliberately (see the comment in
`pnpm-workspace.yaml`), which leaves the Electron binary undownloaded and
node-pty unbuilt. It performs exactly those two steps, is idempotent, and
should be re-run after every `pnpm install`.

The first run reads `~/.config/jarvis/jarvis.yaml`. **There must be one**: with
no config file Jarvis shows "Jarvis failed to start" and quits, because a
sensible default for "which agent runs your code" does not exist. The smallest
file that works declares one agent and an empty brain — see
**[SETUP.md](../../SETUP.md)** for it, and [configuration](configuration.md)
for everything else.

## What each optional tool unlocks

Jarvis works without all of these; each one is missing only the feature it
belongs to, and the feature says so rather than failing quietly.

| Tool | Unlocks | macOS | Linux |
|---|---|---|---|
| A coding agent CLI (`claude`, `copilot`, …) | Sessions — the point of the app | per that tool | per that tool |
| `code-server` | The **Editor** tab | `brew install code-server` | `curl -fsSL https://code-server.dev/install.sh \| sh` |
| `dbgate-serve` | The **Database** tab | `npm i -g dbgate-serve` | `npm i -g dbgate-serve` |
| `headlamp-server` | The **Cluster** tab | `brew install --cask headlamp` | the `.deb`/`.rpm` from [headlamp.dev](https://headlamp.dev) |
| `docker` | The **Docker** tab | Docker Desktop or OrbStack | your distribution's `docker.io` / `docker-ce` |
| `whisper-cli` + a model | Voice input | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) |
| `ffmpeg` | Voice input | `brew install ffmpeg` | `apt install ffmpeg` |
| `piper` + a voice model | Speech out | [piper](https://github.com/rhasspy/piper) | [piper](https://github.com/rhasspy/piper) |
| An audio player | Speech out | built in (`afplay`) | `pipewire-utils`, `pulseaudio-utils` or `alsa-utils` |

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

**Recording** goes through `ffmpeg`, from avfoundation on macOS and from
PulseAudio on Linux. PipeWire ships a PulseAudio shim, so `-f pulse` covers
both sound servers and there is nothing to choose.

**Speaking** differs by platform, because macOS has system voices and Linux
does not.

On macOS, Arabic is a `say` voice and English is either a `say` voice or
Piper, whichever the voice picker in Settings is set to.

On Linux there is no `say`, so both languages go through Piper — and a Piper
model speaks one language, so bilingual speech means two models. English is
`voice.piperModel`, Arabic is `voice.piperArabicModel`. With neither
installed, replies are shown and not spoken, and Jarvis says so rather than
appearing mute. See [configuration](configuration.md).

**The hotkey.** ⌥Space on macOS, Alt+Space on Linux — but under **Wayland** no
application can register a system-wide shortcut at all, and Jarvis says so at
startup. The microphone button and the composer still work; so does binding
the shortcut in your desktop's own keyboard settings. An X11 (or XWayland)
session has the hotkey as normal.

## Verifying the install

```bash
pnpm test        # the whole suite, no network required
pnpm typecheck
```

A green suite says the code is sound; it says nothing about whether the
external tools above are present. Those show up the first time you click the
tab that needs one.
