# Configuration

Everything lives in one file: `~/.config/jarvis/jarvis.yaml`. Jarvis reads it
at startup and the **Settings** route writes it back. A save rewrites the whole
file, so comments in it are lost — the previous version is kept beside it as
`jarvis.yaml.bak-<timestamp>`.

A full example, with every section:

```yaml
agents:
  claude-mm:
    command: claude-mm          # the executable, as you would type it
    model: opus                 # passed as --model
    default: true               # used when no routing rule matches
    configDir: /Users/you/.claude-mm
    vendor: anthropic           # anthropic | github — decides capacity reporting
  copilot:
    command: copilot
    args: ["-p"]
    vendor: github

routing:
  - agent: claude-acme     # must name a configured agent
    match:
      project: acme        # and/or `intent:`

projects:
  acme: /Users/you/projects/acme
  storefront: /Users/you/projects/storefront

databases:                      # optional; per project, for the Database tab
  storefront:
    - id: main                  # letters, digits and underscores only
      label: Sail (local)
      engine: mysql             # mysql | mariadb | postgres | sqlite
      host: 127.0.0.1
      port: 3306
      user: sail
      database: store_saas
      passwordEnv: STORE_SAAS_DB_PASSWORD

editors:                        # optional; per project, for the Editor button
  acme:
    - name: portal-vue          # what the Editor menu shows
      path: portal-vue          # relative to the project, and inside it
    - name: api
      path: api

clusters:                       # optional; per project, for the Cluster tab
  opf:
    - name: dev                 # what the Cluster menu shows
      context: arn:aws:eks:eu-west-1:123456789012:cluster/app_dev
    - name: chaos
      context: arn:aws:eks:eu-west-1:123456789012:cluster/app_staging

headlamp:
  binary: /Applications/Headlamp.app/Contents/Resources/headlamp-server

terminal:
  completion:
    enabled: true             # the Terminal tab's autocomplete dropdown
    historyPath: ~/.zsh_history                      # read, never written
    commandLogPath: ~/.config/jarvis/terminal-commands.log
  blocks:
    enabled: true              # group commands into collapsible blocks
    inputEditor: true          # the multiline command editor at an idle prompt
  notifyAfterSeconds: 30       # notify when an unfocused pane's command runs this long; 0 disables it

workflows:                      # optional; per project, on top of ~/.config/jarvis/workflows/
  acme: ./.jarvis/workflows

brain:
  accountId: claude-mm          # which agent answers voice; needs a configDir
  cwd: /Users/you/.config/jarvis/brain
  systemPrompt: |
    You are Jarvis, a voice assistant that runs coding sessions.

voice:
  engine: piper               # piper (neural, local) or say (macOS)
  piperBinary: ~/.local/bin/piper
  piperModel: ~/.config/jarvis/voices/en-gb-alan-low.onnx
  englishVoice: Daniel        # used when engine is `say`
  arabicVoice: Majed          # always used for Arabic
  greeting:
    en: "Good {timeOfDay} sir, how can I help you today?"
    ar: "{timeOfDay} يا سيدي، كيف أقدر أساعدك اليوم؟"

whisper:
  binaryPath: /Users/you/.voicemode/services/whisper/build/bin/whisper-cli
  modelPath: /Users/you/.whisper-models/ggml-large-v3-turbo.bin

sessions:                       # optional; the whole section defaults
  importWindowDays: 30          # how far back the transcript import reaches
```

## Notes that are easy to get wrong

**`projects` maps a name to a path.** The name is what you say out loud, what
the tab strip shows, and what routing matches on. Everything else in the app
refers to a project by that name; only the main process ever sees the path.

**`brain.accountId` must name an agent that declares a `configDir`.** The brain
runs headless sessions that inherit hooks and skills from their working
directory, which is why `brain.cwd` defaults to a directory with no `.claude`
config of its own. Pointing it at a repository makes the brain inherit that
repository's tooling.

**`terminal.completion.enabled` is one switch, not two.** Setting it to `false`
turns off the dropdown *and* the shell integration behind it, so the Terminal
tab's shell starts with no `ZDOTDIR` of Jarvis's at all. The whole section is
optional and every field has a default, so a config written before this feature
existed keeps loading and gets it.

Your own `~/.zshrc`, `~/.zprofile`, `~/.zshenv` and `~/.zsh_history` are read
and never modified. `commandLogPath` is Jarvis's own file: it records
`epoch`, working directory and command for each command run in a Terminal tab,
which is the only way to rank a command higher in the directory it belongs to —
zsh's history does not record a directory. Delete it whenever you like; it
refills.

**`terminal.blocks.enabled` and `terminal.blocks.inputEditor` are two
switches, not one**, and both default to `true`. `enabled` turns off the
block model entirely — every command and its output go back to being one
undifferentiated scroll, the terminal Jarvis shipped before blocks existed.
`inputEditor` can be turned off on its own, keeping blocks but going back to
typing straight into the live shell; there is no way to have the editor with
blocks off, since the editor's own idle-prompt detection is a block-model
concept. Either switch is one config line away from today's terminal if
anything about the new terminal misbehaves.

**`terminal.notifyAfterSeconds` guards a block finishing in a pane you are
not looking at**, and defaults to `30`. Set it to `0` to turn these
notifications off entirely; a lower number just notifies sooner.

**`workflows` maps a project name to one directory of workflow files**, read
in addition to the always-read `~/.config/jarvis/workflows/` — every project
gets the global directory whether or not it has an entry here, and a key
naming no configured project is rejected at load, the same rule `databases`
and `editors` follow. A workflow file is YAML with a `name`, a `description`
and a `command` that can contain `{{placeholder}}` slots, e.g.:

```yaml
name: Deploy to staging
description: Build and push the current branch to the staging cluster
command: pnpm build && kubectl rollout restart deployment/{{service}} -n staging
```

Choosing "Run workflow…" from the Terminal tab's palette prompts for each
placeholder and fills the input editor with the result — it never runs the
command itself. When the same workflow name exists in both directories, the
project's own directory wins: it shadows the global one, rather than the two
somehow merging or the palette listing the name twice.

**`databases` is keyed by project name**, and a key that names no configured
project is rejected at load. There is deliberately no `password:` field —
`passwordEnv` names an environment variable instead, because Settings rewrites
this file on every save and it should never come to hold a secret. A connection
with no resolvable password makes DbGate ask for it and keep it in that
project's own workspace.

**`editors` is keyed by project name too**, and, like `databases`, a key that
names no configured project is rejected at load. Each entry names a folder
inside the project that the Editor button can open code-server at: with no
entry the editor opens at the project directory as it always did, with one
entry it opens straight into that folder, and with two or more the button
offers a menu. Every open root is its own code-server instance and its own
tab, titled `project — Editor · root`.

`path` is relative to the project directory and must stay inside it. An
absolute path — `~/…` included — is refused at load rather than expanded: an
editor root is a *narrowing* of a project, and the project directory is what
its terminal, git view and API tab all key off, so a root outside it would be
an editor onto something none of them can see. Keeping the path relative is
also what makes the containment rule decidable while reading the file, with no
filesystem to consult.

**`clusters` is keyed by project name too**, and each entry pairs a display
`name` with the kubeconfig `context` it opens. Neither is validated at
startup — Jarvis will not refuse to launch over a cluster you were not going
to open today, and a stale or misspelled context only fails when its own tab
is opened, in the same status-line way a missing binary does.

**Sessions you started in a terminal show up in History too.** Every Claude
Code session writes a JSONL transcript under its account's
`configDir/projects/`, whether Jarvis launched it or you typed the agent into
a terminal yourself. Jarvis reads those transcripts at startup and then
watches for new ones, so History describes the work on the machine rather than
only the part that went through the app.

Three things follow from that, and are worth knowing:

- **An imported session is recorded as `done`.** Jarvis cannot see whether a
  terminal session is still alive — the transcript is not held open between
  writes, and a session's `session-env` directory outlives it — so rather than
  guess, it records when the session was last active and leaves state alone.
- **A session started outside any configured project keeps its directory.**
  Most work happens in directories that are in no `projects:` entry; such a
  session is still recorded, and History shows the directory's name where a
  project name would go. A session inside a project directory (or any
  subdirectory of one) is filed under that project.
- **The brain's own sessions are excluded**, by path: anything at or under
  `brain.cwd`. They are Jarvis talking to itself and would swamp everything
  else.

Only agents with `vendor: anthropic` and a `configDir` are scanned. Copilot
stores its sessions in a different format and is not imported.

**`sessions.importWindowDays` bounds the startup scan**, by file modification
time; it defaults to 30. Sessions older than the window are not imported —
raise it once if you want more history back, and note that anything already
imported stays imported. Everything newer arrives through the watch regardless
of this setting.

**`headlamp` has one key, `binary`**, and it is optional: absent, it falls
back to Headlamp's per-OS install path (see
[installation](installation.md#what-each-optional-tool-unlocks)). Set it only
when Headlamp is installed somewhere else.

**The greeting is a template.** `{timeOfDay}` becomes morning, afternoon or
evening — in Arabic it carries the whole phrase, since صباح الخير is not
decomposable the way "good morning" is. `{ready}`, `{lastSession}` and
`{uncommitted}` are also available and left out of the default deliberately:
the default is a greeting, not a status report, and putting the report back is
a matter of typing a placeholder. A line whose only placeholder has nothing to
say is dropped rather than left blank.

**English speaks through Piper by default; Arabic always through macOS.**
A Piper model speaks one language, so Arabic keeps using `say -v Majed`
whichever engine English is on. Piper is installed with
`uv tool install piper-tts`, and its voice model is a file you download once:

```bash
mkdir -p ~/.config/jarvis/voices && cd ~/.config/jarvis/voices
curl -L -o alan.tar.gz \
  https://github.com/rhasspy/piper/releases/download/v0.0.2/voice-en-gb-alan-low.tar.gz
tar xzf alan.tar.gz && rm alan.tar.gz
```

If either the binary or the model is missing, Jarvis says so on stdout and
falls back to macOS voices rather than going silent — being mute is a worse
failure than sounding synthetic.

**macOS voices are compact by default, and compact voices sound robotic.**
Enhanced and Premium versions are separate downloads: System Settings →
Accessibility → Spoken Content → System Voice → Manage Voices. Jarvis picks the
better version up on its own — a config that says `Daniel` uses
`Daniel (Enhanced)` the moment it exists, with no second edit. The Voice
section of Settings lists what is installed with a **play** button, and says so
when only compact voices are present.

**An unknown voice name fails quietly.** macOS's `say` falls back to the system
default rather than erroring, so a typo in `englishVoice` sounds like the
setting did nothing.

**Comments do not survive a Settings save.** If you keep notes in this file,
keep them somewhere else too.
