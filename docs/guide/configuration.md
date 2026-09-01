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

brain:
  accountId: claude-mm          # which agent answers voice; needs a configDir
  cwd: /Users/you/.config/jarvis/brain
  systemPrompt: |
    You are Jarvis, a voice assistant that runs coding sessions.

voice:
  englishVoice: Daniel        # any `say -v` name; Daniel is the British male
  arabicVoice: Majed
  greeting:
    en: "Good {timeOfDay} sir, how can I help you today?"
    ar: "{timeOfDay} يا سيدي، كيف أقدر أساعدك اليوم؟"

whisper:
  binaryPath: /Users/you/.voicemode/services/whisper/build/bin/whisper-cli
  modelPath: /Users/you/.whisper-models/ggml-large-v3-turbo.bin
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

**`databases` is keyed by project name**, and a key that names no configured
project is rejected at load. There is deliberately no `password:` field —
`passwordEnv` names an environment variable instead, because Settings rewrites
this file on every save and it should never come to hold a secret. A connection
with no resolvable password makes DbGate ask for it and keep it in that
project's own workspace.

**The greeting is a template.** `{timeOfDay}` becomes morning, afternoon or
evening — in Arabic it carries the whole phrase, since صباح الخير is not
decomposable the way "good morning" is. `{ready}`, `{lastSession}` and
`{uncommitted}` are also available and left out of the default deliberately:
the default is a greeting, not a status report, and putting the report back is
a matter of typing a placeholder. A line whose only placeholder has nothing to
say is dropped rather than left blank.

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
