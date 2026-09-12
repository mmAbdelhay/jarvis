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

## Jarvis installs these for you

On its first run — and on any launch where the agent CLI is missing — Jarvis
shows a setup screen listing every tool below, what each one unlocks, and
whether this machine has it. Tick what you want and press install.

Two things it will not do. It never installs anything until you press the
button, and it never runs a command that needs root: those rows show the exact
line for the package manager you actually have, with a copy button. Jarvis
does not ask for your password.

From a clone, the same thing without the window:

```bash
pnpm prereqs              # report only
pnpm prereqs --all        # install everything that needs no root
pnpm prereqs --only=piper,voice-en
```

(`pnpm prereqs`, not `pnpm setup` — that name is a pnpm builtin which
configures pnpm's own home directory and would shadow the script.)

Detection asks the **login shell's** PATH, which is the same PATH Jarvis
resolves its sidecars against. A tool installed under nvm is visible to an
interactive shell and not to a GUI process, so a check against anything else
would tick a box for a tool the app then could not find.

## What each optional tool unlocks

Jarvis works without all of these; each one is missing only the feature it
belongs to, and the feature says so rather than failing quietly.

| Tool | Unlocks | macOS | Linux |
|---|---|---|---|
| A coding agent CLI (`claude`, `copilot`, …) | Sessions — the point of the app | per that tool | per that tool |
| `code-server` | The **Editor** tab | `brew install code-server` | `curl -fsSL https://code-server.dev/install.sh \| sh` — **not** `npm i -g` |
| `dbgate-serve` | The **Database** tab | `npm i -g dbgate-serve` | `npm i -g dbgate-serve` |
| `headlamp-server` | The **Cluster** tab | `brew install --cask headlamp` | the `.deb`/`.rpm` from [headlamp.dev](https://headlamp.dev) |
| `docker` | The **Docker** tab | Docker Desktop or OrbStack | your distribution's `docker.io` / `docker-ce` |
| `whisper-cli` + a model | Voice input | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) |
| `ffmpeg` | Voice input | `brew install ffmpeg` | `apt install ffmpeg` |
| `piper` + a voice model | Speech out | [piper](https://github.com/rhasspy/piper) | the release tarball — see below |
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

**Piper** is a single static binary plus one `.onnx` model per language. On
Linux the release tarball is the least troublesome route, and it wants to land
where `voice.piperBinary` already looks:

```bash
curl -fsSL https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
  | tar xz -C /tmp
mkdir -p ~/.local/lib/piper ~/.local/bin
cp -r /tmp/piper/* ~/.local/lib/piper/
ln -sf ~/.local/lib/piper/piper ~/.local/bin/piper
```

Voices come from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices);
each is an `.onnx` and a `.json` that must sit beside each other. The defaults
Jarvis looks for are `~/.config/jarvis/voices/en-gb-alan-low.onnx` and
`~/.config/jarvis/voices/ar_JO-kareem-low.onnx`.

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

### Why not `npm i -g code-server` on Linux

It pulls `kerberos`, a native module, and building it against Node 22+ fails.
The install script above ships a standalone build with its own Node and needs
no compiler. `--method standalone --prefix "$HOME/.local"` keeps it entirely
inside your home directory, which is enough — Jarvis resolves it on the login
shell's PATH.

## Putting Jarvis in your application launcher

An AppImage is a single file and does not register itself, so until you tell
your desktop about it there is no launcher entry and no icon — which is also
why a window started from a terminal shows a generic one.

[AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) does this
for every AppImage you run. By hand it is two files:

```bash
./Jarvis-*.AppImage --appimage-extract > /dev/null
mkdir -p ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
cp squashfs-root/usr/share/icons/hicolor/512x512/apps/jarvis.png \
   ~/.local/share/icons/hicolor/512x512/apps/
sed "s|^Exec=.*|Exec=$PWD/$(ls Jarvis-*.AppImage) --no-sandbox %U|" \
   squashfs-root/jarvis.desktop > ~/.local/share/applications/jarvis.desktop
update-desktop-database ~/.local/share/applications
```

The bundle sets `StartupWMClass=jarvis` and the window reports `WM_CLASS`
`jarvis`, so once that entry exists the running window is matched to it and
picks up the icon.

## Verifying the install

```bash
pnpm test        # the whole suite, no network required
pnpm typecheck
```

A green suite says the code is sound; it says nothing about whether the
external tools above are present. Those show up the first time you click the
tab that needs one.
