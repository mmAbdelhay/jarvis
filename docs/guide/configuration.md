# Configuration

Everything lives in one file: `~/.config/jarvis/jarvis.yaml`. Jarvis reads it
at startup and the **Settings** route writes it back. A save rewrites the whole
file, so comments in it are lost — the previous version is kept beside it as
`jarvis.yaml.bak-<timestamp>`.

A full example, with every section:

```yaml
agents:
  claude-main:
    command: claude-main          # the executable, as you would type it
    model: opus                 # passed as --model
    default: true               # used when no routing rule matches
    configDir: /Users/you/.claude-main
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
  platform:
    - name: dev                 # what the Cluster menu shows
      context: arn:aws:eks:eu-west-1:123456789012:cluster/app_dev
    - name: chaos
      context: arn:aws:eks:eu-west-1:123456789012:cluster/app_staging

docker:                         # optional; per project, for the Docker tab
  acme:
    - name: app                 # what the Docker tab shows
      container: acme-app-1
    - name: mysql
      container: acme-mysql-1

chat:                           # optional; per project, for the Chat tab
  acme:
    - name: Acme             # what the Chat menu shows
      driver: slack               # slack | teams
      account: acme          # the Slack subdomain
  orbit:
    - name: Globex
      driver: teams
      account: orbit.com           # the Teams tenant domain or id

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
  accountId: claude-main          # which agent answers voice; needs a configDir
  cwd: /Users/you/.config/jarvis/brain
  systemPrompt: |
    You are Jarvis, a voice assistant that runs coding sessions.

voice:
  engine: piper               # piper (neural, local) or say (macOS only)
  piperBinary: ~/.local/bin/piper
  piperModel: ~/.config/jarvis/voices/en-gb-alan-low.onnx
  piperArabicModel: ~/.config/jarvis/voices/ar_JO-kareem-low.onnx
  englishVoice: Daniel        # used when engine is `say`; macOS only
  arabicVoice: Majed          # macOS only — a `say` voice
  speakGreeting: true         # false shows the greeting without saying it
  greeting:
    en: "Good {timeOfDay} sir, how can I help you today?"
    ar: "{timeOfDay} يا سيدي، كيف أقدر أساعدك اليوم؟"

### `voice.piperArabicModel`

A Piper model speaks one language, so bilingual speech takes two models.

On macOS this key is unused: Arabic goes through `say -v <arabicVoice>`, which
is a system voice and needs no download. On Linux there is no `say`, so this
is the only thing that can speak an Arabic reply. Point it at an Arabic
`.onnx` — `ar_JO-kareem-low` is the maintained one — and its `.json` beside
it, exactly as `piperModel` wants for English.

Without it, Arabic replies appear in the panel and are not spoken, and Jarvis
says which key would fix that rather than appearing mute. Which message you
get distinguishes the two cases: with Piper itself missing, the reply names
Piper rather than sending you after an Arabic model you would then have
nothing to play.

whisper:
  binaryPath: /Users/you/.voicemode/services/whisper/build/bin/whisper-cli
  modelPath: /Users/you/.whisper-models/ggml-large-v3-turbo.bin

sessions:                       # optional; the whole section defaults
  importWindowDays: 30          # how far back the transcript import reaches

performance:                    # optional; the whole section defaults
  suspendTabsAfterMinutes: 15   # 0 keeps every tab's renderer alive
  stopSidecarsAfterMinutes: 10  # 0 keeps every sidecar until quit
  terminalScrollback: 5000      # lines each terminal keeps

browser:                        # optional; the whole section defaults
  allowPopups: true             # false opens window.open popups as tabs instead
  # homePage: https://example.com  # optional; opens instead of the built-in
                                 # new-tab page — http(s) only, at most 2048
                                 # characters, no control characters; absent
                                 # keeps today's behaviour

prayer:                         # optional; defaults to disabled
  enabled: true
  location:                     # optional; Alexandria is used when absent
    latitude: 31.2001
    longitude: 29.9187
    name: Alexandria
  notify:                       # optional; every field below is the default
    before: true                 # desktop notification some minutes ahead of each prayer
    beforeMinutes: 10            # 1-60
    atTime: true                 # desktop notification right at each prayer's own time

remote:                         # optional; absent means the bridge does not exist
  enabled: false                # nothing can reach this machine until this is true
  bindAddress: 127.0.0.1        # an IP address, never a hostname; Settings lists yours
  port: 7717                    # 0 picks a free port
  sidecarProxy: false           # Editor, Database and Cluster on the phone; needs a real certificate
  tls:
    certPath: ~                 # e.g. from `tailscale cert <machine>.<tailnet>.ts.net`
    keyPath: ~                  # both absent: self-signed, pinned when you pair
  push:
    enabled: false              # the one part involving a third party
    includeProjectNames: false  # project names in a notification's text
  idleDisableMinutes: 0         # 0 = never; otherwise turn off after this long idle
```

**prayer**: The “Use my location” button asks CoreLocation on macOS. On Linux
and Windows, Chromium may contact Google's location service and can fail without
a key; the latitude and longitude fields in Settings provide a permission-free
fallback. Desktop notifications (a reminder some minutes before each prayer,
and one right at its own time) are on by default whenever prayer itself is
enabled — turn either off, or change how many minutes ahead the first one
fires, from the same Settings section.

## `performance:` — what Jarvis gives back while you are not looking

Three numbers that trade a little freshness for a lot of memory. Every one has
a default that is the recommended setting, the whole section is optional, and
`0` turns each off — restoring exactly what Jarvis did before they existed.

| Key | Default | What it does |
|---|---|---|
| `suspendTabsAfterMinutes` | `15` | A Workspace tab hidden this long loses the Chromium renderer behind it. Each is 80–150 MB, and eight tabs is most of a gigabyte. The tab keeps its place in the strip and its address; clicking it rebuilds the page. A tab that is playing video is never suspended. |
| `stopSidecarsAfterMinutes` | `10` | A `code-server`, `dbgate-serve` or `headlamp-server` instance that no open, unsuspended tab still needs is stopped. code-server alone is 150–250 MB. It starts again on the next open — about a second warm, and see [troubleshooting](troubleshooting.md) for cold. |
| `terminalScrollback` | `5000` | Lines each terminal keeps. xterm stores a line as `Uint32Array(cols × 3)` — 12 bytes a cell — so at 200 columns every 1000 lines is about 2.4 MB **per pane**, and a split tab has one pane per leaf. This was 20 000 (~48 MB a pane) before; set it back if you scroll that far. |

These are the only settings in the file that can make the app *lose*
something to save memory — a page reload, a sidecar restart — which is why
turning each off is one number rather than a mode.

The suspend and stop timers are checked once a minute, so anything can outlive
its timeout by up to a minute. `terminalScrollback` is read when a pane is
built, so a change reaches new terminals rather than open ones.

## `remote:` — reaching this machine from your phone

**Nothing listens unless it is enabled and either a device is already paired
or a pairing window is open.** With `enabled: true` and zero paired devices,
the bridge stays silent until you click **New code** in Settings — opening a
pairing window is what opens the listening socket, on `remote.bindAddress`.
The window (and the socket, if no device ends up paired) closes again after
120 seconds, or immediately on Cancel — unless a confirmation or a pairing
connection is still in progress, in which case it stays open up to 60
seconds longer for that to finish. Once at least one device is paired,
the bridge listens whenever `enabled` is `true`, independent of any pairing
window. The Dashboard's topbar carries a listening indicator whenever a
socket is actually open.

The section is optional, and a new `jarvis.yaml` does not have one: absent
means off, on `127.0.0.1`, so upgrading Jarvis can never open a port. A
Settings save leaves the section out again whenever every value is back at its
default.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | The master switch. |
| `bindAddress` | `127.0.0.1` | The one address the bridge will listen on. Must be an IP address: `localhost` or a `*.ts.net` name is refused, because a hostname would put a DNS lookup in charge of who can connect. `0.0.0.0` and `::` are allowed and mean every network this machine is on; Settings warns when you pick them. In YAML, `::` must be quoted — `bindAddress: "::"` — because the unquoted form is invalid YAML and the whole config fails to load. |
| `port` | `7717` | A whole number from 0 to 65535. `0` asks the system for a free port, and the pairing code carries whichever one it got. |
| `sidecarProxy` | `false` | Lets a paired phone open the Editor, Database and Cluster tabs through an in-app reverse proxy on the bridge listener, at `/s/<handle>/…`. It needs a real, configured certificate with a DNS name (`tls.certPath`/`keyPath` below) because a phone's web view cannot be told to trust a self-signed one: with the toggle on but only a self-signed certificate served, Settings shows a warning and the phone's Editor/Database/Cluster rows answer "needs a real certificate" rather than opening. See [Remote access](remote-access.md) for the `tailscale cert` walkthrough and what the proxy exposes. |
| `tls.certPath`, `tls.keyPath` | absent | Both or neither, and file paths only — there is no Settings-panel equivalent. Neither means a self-signed certificate, made once and pinned when you pair. A real one comes from `tailscale cert <machine>.<tailnet>.ts.net`; see [Remote access](remote-access.md) for the full walkthrough, including renewal. `~/` is expanded. The pairing link's name, and the sidecar proxy's gate, come from the first DNS name on that certificate that is a plain hostname — not a wildcard; a certificate whose only names are wildcards is treated the same as one with no DNS name at all. |
| `push.enabled` | `false` | Turns laptop push delivery on when the phone has also enabled notifications and registered a token. A notification carries only a generic bilingual title and body plus `{kind, sessionId?}` in its data — never agent output, a file, a command, a path or a transcript. Pushes keep flowing while `remote.enabled` is false as long as `push.enabled` is true and a registered token exists. See [Remote access](remote-access.md) for what each kind says and when nothing is sent at all. |
| `push.includeProjectNames` | `false` | Adds the project name to eligible notification text and data. It is controlled by the **include project names** checkbox in Settings. |
| `idleDisableMinutes` | `0` | A whole number from 0 to 10080 (one week). The Settings idle field turns the bridge off after this many minutes with no connected paired phone and no open pairing code; when it fires, the bridge closes the listener and main only writes `remote.enabled: false` to `jarvis.yaml`. `0` never auto-disables. |

**Settings lists your addresses for you.** "Reachable on" offers two radios:
**Tailscale** (this machine's `100.x.y.z` tailnet address, disabled with a
note to install Tailscale when it has none) and **Local Wi-Fi** (its LAN
address, preferring `en0`/`en1` and skipping bridge/VPN interfaces). When
`bindAddress` is still `127.0.0.1`, Tailscale is pre-selected if this machine
has one, otherwise Local Wi-Fi. An **Advanced…** disclosure holds everything
else — *this machine only*, IPv6 addresses, any other interface, and **Other…**
for typing an address that is not listed — and opens itself when the saved
address is one of those. Every address is sorted by range rather than
interface name, so the list looks the same on macOS, Linux and Windows.
Link-local addresses (`fe80::…`, `169.254.x.x`) are not offered.

**No Tailscale credential is ever involved.** Install Tailscale on your own
account at the OS level, restart Jarvis, and its `100.x.y.z` address appears
in the list. Jarvis needs nothing else from it: no account, API key or auth key.

**While it is on, a paired device can run commands on this machine as you.**
There is no lower-privilege version of this feature.

See [Remote access](remote-access.md) for the phone side of pairing: the
confirm step, what the phone can see, and what happens on revocation.

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

**`docker` stores a container's name, not its id.** A `docker compose down`
followed by `up` gives a container the same name and a new id, so a stored id
would go stale on every restart of the stack. There is no compose-file field
either: the compose project is read from the containers' own
`com.docker.compose.project` labels, so there is no second copy of that fact
to drift. Settings can fill this section in for you — see the Docker section
there.

**`chat` holds no token, and never will while the tab is a web page.** A Chat
tab is the project's Slack or Teams on the web, opened in that project's own
Chromium partition — the same cookie jar its ordinary browser tabs use. So
you log into it once, in the tab, and it stays logged in across restarts;
and two projects on two different Teams tenants never see each other's
session. There is deliberately no `tokenEnv` here even though `databases`
has its `passwordEnv`: nothing in Jarvis calls a chat API, and a
secret-shaped key with nothing reading it is a lie in a file Settings
rewrites on every save.

`driver` picks the messaging driver — `slack` or `teams` — and `account`
says which org: for Slack the subdomain (`acme` opens
`acme.slack.com`), for Teams the tenant domain or id. `account` is
optional, and leaving it out opens the provider's own picker, which is the
right thing when you have only one. It may not be *empty*: `account: ""` is
refused at load, because an emptied key is far more likely a mistake than a
request for the picker, and it would otherwise build `https://.slack.com/`.

Like the four sections above it, `chat` is keyed by project name and a key
naming no configured project is refused at load — so the Personal browser
cannot have one. A project may list more than one entry: with one the Chat
button opens it, with two or more it offers a menu, exactly as the Editor
and Cluster buttons do.

Whether a given Teams tenant will actually open is your organisation's call,
not Jarvis's. A Conditional Access policy that demands a managed or
compliant device will refuse a browser Jarvis is hosting, the same way it
would refuse any unenrolled browser; the desktop Teams app works because it
is the approved client on a registered device. Try the tenant in a clean
browser profile first if you are not sure.

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
