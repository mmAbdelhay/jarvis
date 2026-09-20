# Setting up Jarvis on a new machine

Start to finish, about ten minutes. Everything here has been run on a clean
account; nothing is assumed.

## 1. Prerequisites

- **macOS (Apple Silicon), Linux (x64) or Windows (x64).** All three are built
  and run. What differs on Windows — the PowerShell terminal, the chords, the
  voice, and the Editor tab, which has no Windows build — is collected under
  "On Windows" in [installation](docs/guide/installation.md#on-windows).
- **Node 24 or newer** — `node --version` to check. Not 22: the session
  store is built on `node:sqlite`, which Node 22 does not carry, and the test
  suite does not load without it.
- **pnpm** — the version is pinned in the repo, so let corepack pick it:

```bash
corepack enable
```

**On Linux, one more thing.** node-pty ships prebuilt binaries for macOS and
Windows only, so on Linux it is compiled during setup and wants a C++
toolchain and Python:

```bash
sudo apt install -y build-essential python3     # Debian, Ubuntu
sudo dnf install -y gcc-c++ make python3        # Fedora, RHEL
sudo pacman -S --needed base-devel python       # Arch
```

Every agent session and every Terminal tab is a pty, so this is not optional.

## 2. Get it running

```bash
git clone <this repo> jarvis && cd jarvis
pnpm install
pnpm bootstrap
pnpm --filter @jarvis/desktop start
```

`pnpm bootstrap` downloads the Electron binary and, on Linux, compiles
node-pty. It is a required step, not a convenience: this workspace runs with
install scripts disabled on purpose, so `pnpm install` leaves both undone.
Re-run it after every `pnpm install`. It is idempotent and says what it did.

`start` builds first and then opens the app. The first build takes a minute or
two; after that it is seconds.

It will fail on this first run, with **"Jarvis failed to start"**. That is
expected — there is no configuration file yet. Step 3 writes one.

## 3. The one file you must write

Jarvis reads `~/.config/jarvis/jarvis.yaml` at startup. **On first run it
writes one for you** — a single agent and an empty brain — so a fresh install
opens rather than refusing to start. What follows is that same file, written
by hand, plus what to change in it.

This is the smallest file that works:

```bash
mkdir -p ~/.config/jarvis
cat > ~/.config/jarvis/jarvis.yaml <<'YAML'
agents:
  claude:
    command: claude       # the coding-agent CLI, as you would type it
    default: true

brain: {}
YAML
```

Two sections are required — `agents` (at least one) and `brain` (which may be
empty). Everything else is optional.

Run `pnpm --filter @jarvis/desktop start` again and the app opens, full screen.

## 4. Add your projects

A project is a name and a path. The name is what you say out loud, what the tab
strip shows, and what routing matches on.

```yaml
projects:
  my-app: /Users/you/projects/my-app
```

Add it to the file, or use the **Settings** route inside the app, which writes
the same file. Either way: **nothing is applied until you restart** — Settings
shows a **Restart Jarvis** button once a save succeeds.

At this point the Workspace works: a browser, a terminal in the project, and
the API client. The Editor and Database tabs need one more install each.

## 5. Optional tools

Each one is missing only the feature it belongs to, and the app says so in the
toolbar rather than failing quietly. Install what you need, skip the rest.

| Want | macOS | Linux | Windows |
|---|---|---|---|
| **Editor** tab (VS Code in a tab) | `brew install code-server` | `curl -fsSL https://code-server.dev/install.sh \| sh` | — code-server has no Windows build |
| **Database** tab (SQL client) | `npm i -g dbgate-serve` | `npm i -g dbgate-serve` | `npm i -g dbgate-serve` |
| **Voice input** | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) + a model, and `brew install ffmpeg` | the same, and `apt install ffmpeg` | the same, and `winget install ffmpeg` |
| **A voice to speak with** | `uv tool install piper-tts` | `uv tool install piper-tts`, plus `pipewire-utils`, `pulseaudio-utils` or `alsa-utils` to play it | nothing — Windows' own System.Speech voices speak out of the box; `uv tool install piper-tts` sounds better |

For voice input, add the two paths and restart:

```yaml
whisper:
  binaryPath: /Users/you/.voicemode/services/whisper/build/bin/whisper-cli
  modelPath: /Users/you/.whisper-models/ggml-large-v3-turbo.bin
```

Use the `large-v3-turbo` model, not `base`. `base` mis-transcribes Arabic
project names badly enough to send an instruction to the wrong agent.

**On Linux, speech needs two Piper models.** There is no `say`, so both
languages go through Piper — and one Piper model speaks one language:

```yaml
voice:
  piperModel: ~/.config/jarvis/voices/en-gb-alan-low.onnx
  piperArabicModel: ~/.config/jarvis/voices/ar_JO-kareem-low.onnx
```

With neither, replies are shown and not spoken, and Jarvis says which key
would fix it.

**Capacity meters (optional, free).** The Providers panel shows how much of
each account's allowance is left, and never asks a model for it (that would
cost a billed query each time). Codex needs nothing: it records its own rate
limits in its session logs. Copilot needs nothing on macOS either — the
meter asks as the Copilot CLI's own signed-in account (its keychain token;
approve the one-time keychain prompt) and falls back to `gh` (`gh auth
login`) elsewhere.
A Claude account reads the figures Claude Code already hands its status line. Point each account's status line at the
hook, in that account's `settings.json` (`~/.claude/settings.json`, or the
config dir the account uses):

```json
"statusLine": { "type": "command", "command": "sh /path/to/jarvis/scripts/claude-usage-snapshot.sh" }
```

Already have a status line? Keep it and add one line near its top:
`input=$(cat); printf '%s' "$input" | sh /path/to/jarvis/scripts/claude-usage-snapshot.sh >/dev/null`.
The meter fills in the next time that account renders its status line
(open Claude Code once); until then the row says "no usage reading yet".

**Phone (optional).** The companion app (`apps/mobile`) pairs with Settings →
Remote access; the Editor, Database and Cluster tabs additionally need a real
certificate to open on the phone at all:

1. Install [Tailscale](https://tailscale.com/) on both this machine and the
   phone, and sign both into the same tailnet.
2. In the Tailscale admin console, turn on **HTTPS certificates** (DNS →
   HTTPS Certificates) for the tailnet.
3. In Settings → Remote access, click **Get certificate from Tailscale**,
   then turn the sidecar proxy on (it turns on by itself once the
   certificate is issued).

See [Remote access](docs/guide/remote-access.md) for pairing itself and what
each tab needs.

## 6. Check it works

```bash
pnpm test        # the whole suite, no network needed
pnpm typecheck
```

A green suite says the code is sound. It says nothing about whether the
external tools above are installed — those show up the first time you click the
tab that needs one.

## If something goes wrong

| Symptom | Cause |
|---|---|
| "Jarvis failed to start" | No config file, or a syntax error in it. The dialog quotes the line. |
| Editor or Database errors in the toolbar | `code-server` or `dbgate-serve` is not installed. |
| Editor or Database takes ~10s the first time | Normal — that is the binary's own start-up. Hover the button before clicking and it starts early. |
| Settings saved, nothing changed | Nothing is applied live. Press **Restart Jarvis**. |
| The app looks stale after editing code | `tsc` alone is not the build. Run `pnpm --filter @jarvis/desktop build`. |

More in [troubleshooting](docs/guide/troubleshooting.md).

## Where to go next

- **[Configuration](docs/guide/configuration.md)** — every key of `jarvis.yaml`
- **[Workspace tabs](docs/guide/workspace-tabs.md)** — what each tab does
- **[Architecture](docs/develop/architecture.md)** — if you are going to change the code
