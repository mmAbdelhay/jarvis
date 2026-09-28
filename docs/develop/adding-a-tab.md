# Adding a Workspace tab

The Workspace has several kinds of tab (`TabKind` in
`packages/core/src/workspace/types.ts`), and they come in three shapes. Pick
the one that matches what you are adding.

Two classes split the work (see [architecture](architecture.md#inside-desktop)):
**`TabHost`** (`packages/desktop/src/core/tab-host.ts`) holds the tab state
in the core, with no Electron import, and **`ViewReconciler`**
(`packages/desktop/src/view-reconciler.ts`) follows that state in the
Electron app and keeps one `WebContentsView` per tab that `hasView` says
should have one. A new tab is almost always a change to the first; the
second follows on its own.

## Shape 1 — a hosted web app (Editor, Database, Cluster)

Something that already exists and speaks HTTP. Spawn it per project, open its
URL as a tab. The whole cost is a manager.

1. `TabKind` gains the name; `HOSTED_APP_LABELS` in `core/tab-host.ts` gains
   its tab-strip label.
2. A manager in `platform`, modelled on `code-server.ts`: `open(project)`
   reuses or spawns, `stopAll()` kills everything on quit, every side effect
   injected.
3. A handler in `ipc.ts`, wired into the core in `core/compose.ts` and keyed
   by its channel in `dispatch.ts`, that resolves the project name to a
   path, wraps the manager's developer-facing detail behind one bilingual
   headline, and opens the tab with `TabHost.open(project, url, kind)`. Classify its channel in
   `remote-policy.ts`; there is no default, so forgetting is a compile error.
4. A button in the workspace head that reuses an existing tab before opening a
   second.

**Bind it to loopback if you possibly can.** code-server does; DbGate cannot,
which is why that one carries a generated login instead.

## Shape 2 — a surface the renderer draws (Terminal, API, Docker)

No hosted page at all: state in the core, pixels in the renderer.

1. `TabKind` gains the name, `VIEWLESS_KINDS` in `core/tab-host.ts` gains it
   (so `hasView` is false and the reconciler never builds a view), and
   `RENDERER_DRAWN` in `renderer/workspace.ts` gains it too — that set is
   what hides the page slot, which is a flex sibling that would otherwise
   split the height with your pane.
2. An `openX(project)` method on `TabHost`, like `openTerminal`, `openApi`
   and `openDocker`, creates the tab through its private `#openViewless`.
   Because the tab has no view, the `ViewReconciler` hides every hosted page
   while it is active, for free.
3. Your pane renders from workspace state — `renderX(tabs, activeTabId,
   selectedProject)` — and shows only when the active tab is yours *and*
   belongs to the selected project. The second half matters: switching to a
   project with no open tab leaves the previous project's tab active in the
   store, and the reconciler hides its views (`hideAll`) behind a flag the
   renderer cannot see.
4. Eviction already leaves it alone. The `MAX_TABS` cap counts only tabs
   `hasView` says hold a page, because it bounds Chromium processes; closing
   a viewless tab would free nothing and lose the process behind it.

## Shape 3 — an ordinary page

`TabHost.open(project, url)`. Nothing else to do.

## In every case

- The chrome rule (`kind !== "web"`) hides the address bar and bookmarks
  already. You do not need to touch it.
- A hosted app's title is fixed at open; a page's title follows the document.
- If your tab owns a child process, kill it in `close()` **and** on quit.
- Keep `core/tab-host.ts` free of Electron (`core/no-electron.test.ts`): the
  headless daemon runs it too. Anything that needs a window belongs in the
  reconciler or `desktop-only.ts`.
- Add the new ids to `index.html` and let `id-contract.test.ts` check them.
