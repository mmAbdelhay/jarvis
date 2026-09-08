# Setting up Jarvis on a new machine

Start to finish, about ten minutes. Everything here has been run on a clean
account; nothing is assumed.

## 1. Prerequisites

- **macOS.** Jarvis has only ever been run there. Nothing in it is
  deliberately Apple-only, but the disk metric knows about APFS and the voices
  come from `say`.
- **Node 22 or newer** — `node --version` to check.
- **pnpm** — the version is pinned in the repo, so let corepack pick it:

```bash
corepack enable
```

## 2. Get it running

```bash
git clone <this repo> jarvis && cd jarvis
pnpm install
pnpm --filter @jarvis/desktop start
```

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

| Want | Install |
|---|---|
| **Editor** tab (VS Code in a tab) | `brew install code-server` |
| **Database** tab (SQL client) | `npm i -g dbgate-serve` |
| **Voice input** | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) + a model |
| **A better voice** | `uv tool install piper-tts` |

For voice input, add the two paths and restart:

```yaml
whisper:
  binaryPath: /Users/you/.voicemode/services/whisper/build/bin/whisper-cli
  modelPath: /Users/you/.whisper-models/ggml-large-v3-turbo.bin
```

Use the `large-v3-turbo` model, not `base`. `base` mis-transcribes Arabic
project names badly enough to send an instruction to the wrong agent.

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
