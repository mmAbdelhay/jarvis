# Adding a Workspace tab

The Workspace has five kinds of tab and they were built in three different
shapes. Pick the one that matches what you are adding.

## Shape 1 — a hosted web app (Editor, Database)

Something that already exists and speaks HTTP. Spawn it per project, open its
URL as a tab. The whole cost is a manager.

1. `TabKind` gains the name; `HOSTED_APP_LABELS` gains its tab-strip label.
2. A manager in `platform`, modelled on `code-server.ts`: `open(project)`
   reuses or spawns, `stopAll()` kills everything on quit, every side effect
   injected.
3. An IPC handler that resolves the project name to a path and wraps the
   manager's developer-facing detail behind one bilingual headline.
4. A button in the workspace head that reuses an existing tab before opening a
   second.

**Bind it to loopback if you possibly can.** code-server does; DbGate cannot,
which is why that one carries a generated login instead.

## Shape 2 — a surface the renderer draws (Terminal, API)

No hosted page at all: state in main, pixels in the renderer.

1. `TabKind` gains the name, and `RENDERER_DRAWN` in `workspace.ts` gains it
   too — that set is what hides the page slot, which is a flex sibling that
   would otherwise split the height with your pane.
2. `BrowserHost.openViewless` creates the tab. Because it has no view,
   `#syncVisibility` hides every hosted page while it is active, for free.
3. Your pane renders from workspace state — `renderX(tabs, activeTabId,
   selectedProject)` — and shows only when the active tab is yours *and*
   belongs to the selected project. The second half matters: switching to a
   project with no open tab leaves the previous project's tab active in the
   store, and main hides its views behind a flag the renderer cannot see.
4. Exempt it from eviction if it holds a process. The cap counts Chromium
   views; closing your tab to free one frees nothing and loses the process.

## Shape 3 — an ordinary page

`openTab(project, url)`. Nothing else to do.

## In every case

- The chrome rule (`kind !== "web"`) hides the address bar and bookmarks
  already. You do not need to touch it.
- A hosted app's title is fixed at open; a page's title follows the document.
- If your tab owns a child process, kill it in `close()` **and** on quit.
- Add the new ids to `index.html` and let `id-contract.test.ts` check them.
