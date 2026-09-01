# Workspace tabs

The Workspace is a browser whose tabs are not all web pages. Each tab belongs
to a project, and its kind decides what chrome makes sense around it.

| Kind | What it is | Address bar & bookmarks |
|---|---|---|
| `web` | An ordinary page | shown |
| `editor` | code-server, one instance per project | hidden |
| `database` | DbGate, one instance per project | hidden |
| `terminal` | A login shell under a pty | hidden |
| `api` | The API client | hidden |

Browser chrome belongs to browser tabs: anything that is not a plain page hides
the address bar and the bookmarks sidebar, because nobody navigates an editor
or a shell the way they navigate a website.

## The browser

An address bar, back/forward/reload, and per-project bookmarks kept in
`~/.config/jarvis/bookmarks.json`. Clicking a bookmark the project already has
open activates that tab rather than opening a second copy.

**☰** toggles the bookmarks sidebar. **⚙** opens DevTools for the current
page — the real DevTools front end, network and application panels included,
rendered into a panel you can drag to size rather than a detached window.

Tabs from other projects collapse into a counted, coloured pill; the selected
project's tabs expand. Eight hosted pages is the cap — each is a Chromium
process — and terminal and API tabs are exempt, since they are neither.

## Editor

Spawns `code-server` for the project on a free loopback port and opens it as a
tab. One instance per project, reused, and killed when Jarvis quits.

## Database

Spawns `dbgate-serve` for the project — a full SQL client: schema tree, data
grid, query editor. Connections come from the `databases:` section of
`jarvis.yaml` (see [configuration](configuration.md)), and a project that
declares none gets an instance that manages its own.

**Every instance is guarded by a generated login**, shown in the status line
when the tab opens. DbGate always listens on `0.0.0.0` and offers no way to
bind to loopback, unlike code-server; the credential is the mitigation. It is
a per-spawn random value and changes when Jarvis restarts.

## Terminal

Your login shell (`$SHELL -l`), rooted at the project, under a real pty. One
per tab — two terminals in the same project is an ordinary thing to want.
Scrollback survives switching tabs; closing the tab kills the shell.

**Shift+Enter** sends ESC+CR rather than a bare carriage return, which is what
makes it mean *newline* to Claude Code and every other agent UI. **⌘F** finds,
**⌘C** copies the selection, **⌘V** pastes, **⌘K** clears. Ctrl chords are left
alone — those are real control bytes a program may want.

## API

A request builder over the project's own Bruno collections. See
**[the API client](api-client.md)**.
