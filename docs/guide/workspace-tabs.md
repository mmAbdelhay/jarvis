# Workspace tabs

The Workspace is a browser whose tabs are not all web pages. Each tab belongs
to a project — or to the personal browser, which is a project in every respect
but the one that matters — and its kind decides what chrome makes sense around
it.

| Kind | What it is | Address bar & bookmarks |
|---|---|---|
| `web` | An ordinary page | shown |
| `editor` | code-server, one instance per project *root* | hidden |
| `database` | DbGate, one instance per project | hidden |
| `terminal` | A login shell under a pty | hidden |
| `api` | The API client | hidden |
| `cluster` | A Kubernetes cluster browser | hidden |
| `docker` | The project's containers | hidden |

Browser chrome belongs to browser tabs: anything that is not a plain page hides
the address bar and the bookmarks sidebar beside it, because nobody navigates
an editor or a shell the way they navigate a website.

## The browser

An address bar, back/forward/reload, and per-project bookmarks kept in
`~/.config/jarvis/bookmarks.json`. Clicking a bookmark the project already has
open activates that tab rather than opening a second copy.

Bookmarks sit in a sidebar down the left of the Workspace, in two parts. The
**essentials** are up to twelve pinned bookmarks shown as a grid of icons —
the handful you open daily, reachable without reading. Everything else is
listed below them, each row showing its icon too, then its title.

Pin a bookmark with the **⊞** on its row, or by dragging it from the list
into the grid; take one back out with the **⊟** in the corner of its tile, or
by dragging it down into the list. Drag within either group to reorder. A
thirteenth pin is refused rather than pushing one out: the grid is a fixed
twelve.

Icons come from the site itself. Jarvis keeps the favicon Chromium resolved
when you last visited a page, and for a bookmark you have never opened it
asks that site for its own icon, trying again every few days if it has
none — never a third-party icon service, so no list of the sites you
bookmark ever leaves your machine. A site with no icon gets a coloured tile
bearing the first letter of its title.

The sidebar is a fixed width beside the hosted page, not a resizable split —
its width is the page's left inset. **☰** collapses it out of the way.

**⚙** opens DevTools for the current
page — the real DevTools front end, network and application panels included,
rendered into a panel you can drag to size rather than a detached window.

**▣** floats the page's video in a small always-on-top window — the "play
popup". It appears only while the page actually has a video playing, so it is
never a dead button; a second press puts the video back in the tab. The window
is Chromium's own Picture-in-Picture window, so it stays above the Workspace,
above Jarvis's other routes, and above other applications entirely. See
[the spike](../../spikes/pip/FINDINGS.md) for why it is that window and not one
of ours.

Tabs from other projects collapse into a counted, coloured pill; the selected
project's tabs expand. Eight hosted pages is the cap — each is a Chromium
process — and terminal and API tabs are exempt, since they are neither.

## Personal — the browser that belongs to no project

The last entry in the project selector is **Personal**: somewhere to keep tabs
that are not work. Its tabs stay open, in place and logged in as the project
selection changes around them, exactly as any other project's do — switching
away collapses them into a counted pill, switching back finds them as they
were.

It is a project as far as the tab strip, the tab store, the bookmark file and
the cookie jar are concerned. The one thing it does not have is a **directory
on disk**, and everything follows from that:

- **Editor, Database, Terminal and API are disabled**, with the reason shown
  beside them. There is no folder to edit, no cwd for a shell, and no
  collection tree to read.
- **Cluster and Docker are disabled too, but for a different reason**: Personal
  has no `clusters:` entry and no `docker:` entry, not because it has no
  directory. The reason shown beside each button says so — "No clusters
  configured for this project", "No containers configured for this project" —
  the same message any ordinary project gets when it declares none.
- **It never appears where "a project" means "a repo".** The Changes view, git
  polling, session routing and the Dashboard's project list all resolve a
  project through `projects:` in `jarvis.yaml`, which it is deliberately absent
  from. `jarvis.yaml` is refused at load time if it tries to declare a project
  under the reserved name.
- **Its logins are its own.** It gets its own persistent session partition,
  like every project, so a page opened by a work project cannot ride the
  accounts you are signed into here. The cost is signing in twice where you use
  the same site for both, which is the right way round.
- **Bookmarks** work exactly as a project's do, kept under their own key in the
  same `bookmarks.json`.
- **Its tabs count against the eight-page cap** like any other. The cap bounds
  Chromium renderer processes and these are Chromium renderer processes; a long
  personal session is exactly the thing the cap exists to survive.

## Editor

Spawns `code-server` on a free loopback port and opens it as a tab. One
instance per (project, root), reused, and killed when Jarvis quits.

**A project can name the folders it wants edited.** A large project is usually
worked on two folders at a time, not thirty, so the `editors:` section of
`jarvis.yaml` (see [configuration](configuration.md)) lists the roots the
Editor button offers for a project:

```yaml
editors:
  acme:
    - { name: portal-vue, path: portal-vue }
    - { name: api, path: api }
```

With no entry — which is most projects — the button opens the project
directory, exactly as it always did. With one root it opens straight into that
folder. With two or more it drops a small menu under the button to pick from;
picking one opens it, and clicking the button again puts the menu away.

Each root is its own editor: its own code-server instance, its own tab, and a
title that says which one (`acme — Editor · api`), so two editors of the
same project are tellable apart in the tab strip. Asking for a root that is
already open activates its tab instead of starting a second instance.

A root's path is relative to the project and must stay inside it; the config
refuses anything else at load, and the manager refuses it again before
spawning.

**Starting is not instant, and the toolbar says so.** code-server takes about a
second to boot when its files are warm in the page cache and closer to nine
when they are not; that is its own start-up and nothing here makes it faster.
What the button does is stop pretending otherwise: it disables itself and the
toolbar reads *Starting the editor…* until a tab exists.

**Hovering the button starts it.** The pointer arriving is the first evidence
you want an editor, a few hundred milliseconds before the click, so the spawn
begins then. It costs nothing extra if you do click — the manager shares one
start per (project, root), so the click joins the start already running rather
than beginning a second — and costs exactly what clicking later would have if
you do not. Measured on a warm machine: about 5.4s from a cold click, about
90ms from a click after a hover. Keyboard focus counts as a hover, and a
project whose editor is already open is not warmed again.

## Database

Spawns `dbgate-serve` for the project — a full SQL client: schema tree, data
grid, query editor. Connections come from the `databases:` section of
`jarvis.yaml` (see [configuration](configuration.md)), and a project that
declares none gets an instance that manages its own.

DbGate is the slower of the two to start — a second or so warm, and twenty or
more cold — so the Database button behaves like the Editor one: it disables
itself, the toolbar reads *Starting the database browser…* for the whole wait,
and hovering the button begins the start early.

**Every instance is guarded by a generated login**, shown in the status line
when the tab opens. DbGate always listens on `0.0.0.0` and offers no way to
bind to loopback, unlike code-server; the credential is the mitigation. It is
a per-spawn random value and changes when Jarvis restarts.

## Cluster

Spawns `headlamp-server` for the project and opens it as a tab — a Kubernetes
cluster browser in the shape of Lens or OpenLens, scoped to the clusters the
project declares. One instance per *project*, not per cluster: the same
server is reused for every cluster you open from it, and `-skipped-kube-contexts`
is what keeps it from also showing every other cluster your kubeconfig knows
about.

**Which clusters the button offers comes from `clusters:`** in `jarvis.yaml`
(see [configuration](configuration.md)). A project with no entry there gets a
disabled button reading *No clusters configured for this project*. One
cluster opens straight away; two or more drop a menu under the button listing
their names, and picking one opens it. Opening a cluster that already has a
tab activates that tab instead of starting a second one. Each open cluster
gets its own tab, titled `project — Cluster · cluster-name`.

**Starting is not instant.** `headlamp-server` measures about twelve seconds
cold, so the button disables itself and the toolbar says so until the tab is
ready — the same pattern as Editor and Database. **Hovering the button** warms
the server early, for the same reason hovering warms the Editor: the pointer
arriving is the first evidence you want it, and the spawn is shared, so a
click that follows the hover joins a start already in progress instead of
beginning a second one. Hovering only warms the server, though — it never
logs you in to AWS, so a pointer crossing the button cannot open a terminal
or send an MFA push to your phone. That happens on the click.

**Jarvis does not manage cluster credentials.** The server reads your real
kubeconfig and inherits whatever authenticates it — including a context whose
credentials come from an `exec` plugin such as `aws eks get-token`, `gcloud`,
or `kubelogin`. Those need a session that is already valid, because a spawned
server has no terminal to prompt you in; see
[troubleshooting](troubleshooting.md) for what that looks like when it fails.

**The exception is AWS.** For a context whose credential plugin is
`aws eks get-token`, Jarvis logs you in itself rather than asking you to have
done it first: it opens a Terminal tab, runs
`saml2aws login && aws eks update-kubeconfig …` there, and opens the cluster
once that succeeds. Approve the MFA push when it arrives; the cluster tab
follows. If it does not, see
[troubleshooting](troubleshooting.md) for the timeout.

Like the Editor tab, the server binds to `127.0.0.1` only — no generated
login, because loopback is the whole mitigation.

## Docker

One tab per project, listing the containers `docker:` maps to it, under a
count of how many of them are up. Each row is led by a dot — filled when the
container is running, amber while it is restarting or paused, hollow when
Docker has no such container — and shows the container's own status line
(Docker's words, unchanged — `Up 3 hours`, `Exited (0) 2 minutes ago`) and the
ports it publishes.

The buttons on the right of each row are ▶ start, ■ stop, ↻ restart, and ❯,
which opens a Terminal tab already inside the container. They are dimmed until
you hover the row or select it; hovering any of them names it. A row
configured in `docker:` with no matching container shows greyed out instead of
a status — see
[troubleshooting](troubleshooting.md#a-container-in-the-docker-tab-is-greyed-out).

The containers sit in a column down the left; selecting one tails its log in
the pane beside them, which says so until you pick one — one `docker logs -f`
at a time, for the row you are looking at. Switching away from the tab stops that follower rather than
leaving it running for a pane nobody is watching, so coming back starts the
tail again from Docker's own last 500 lines. When every container in the
list belongs to one compose project, **Up** and **Down** appear above the
rows, and act on the stack as a whole.

Stop, Restart and Down ask first. Start and Up do not: neither interrupts
anything that is running.

The list refreshes every three seconds while the tab is visible, because
containers stop without asking Jarvis first.

## Terminal

Your login shell (`$SHELL -l`), rooted at the project, under a real pty. One
per tab — two terminals in the same project is an ordinary thing to want.
Scrollback survives switching tabs; closing the tab kills the shell.

**Shift+Enter** sends ESC+CR rather than a bare carriage return, which is what
makes it mean *newline* to Claude Code and every other agent UI. **⌘F** finds,
**⌘C** copies the selection, **⌘V** pastes, **⌘K** clears. Ctrl chords are left
alone — those are real control bytes a program may want.

### Autocomplete

As you type, a dropdown appears under the cursor with the commands you
actually run. **↑/↓** move, **Tab** or **Enter** accepts, **Esc** closes.
Accepting only fills the line in — you still press Enter yourself.

Suggestions come from three places, in order:

1. **Your shell history**, whole, arguments included — `saml2aws login`, not
   `saml2aws`. Ranked by how often and how recently you have run something,
   and boosted for the directory you are in, so `./scripts/port-forward-dev2.sh`
   surfaces in the repo it belongs to and stays out of the way everywhere else.
2. **Paths**, completed against the directory the token you are typing names.
3. **A small built-in table** of subcommands and flags for `git`, `docker`,
   `npm`, `pnpm`, `gh` and `go`.

While the dropdown is shut, every key goes to zsh unchanged — Tab is still
zsh's own completion, ↑ is still history. Nothing is intercepted until there
is something to intercept it for.

Finding the prompt needs a shell hook, which Jarvis installs by pointing the
terminal's `ZDOTDIR` at a directory of its own whose files source yours.
**Your `~/.zshrc`, `~/.zprofile`, `~/.zshenv` and `~/.zsh_history` are read and
never modified.** Directory affinity needs a working directory that zsh's
history does not record, so Jarvis keeps its own log at
`~/.config/jarvis/terminal-commands.log`.

zsh only. Under any other shell nothing is installed and no dropdown appears —
the terminal is exactly the one you have today. The same is true of every
failure: an unreadable history, a wrapper that cannot be written, a prompt with
no marks. To turn the whole thing off, including the `ZDOTDIR` injection:

```yaml
terminal:
  completion:
    enabled: false
```

See **[configuration](configuration.md)** for `historyPath` and
`commandLogPath`.

## API

A request builder over the project's own Bruno collections. See
**[the API client](api-client.md)**.
