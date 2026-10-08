import { createFileTree, type FileTreeTarget } from "./file-tree.js";
import { formatCwd } from "./terminal-chips.js";
import type { DirEntry, EntryKind, FileOpResult } from "../src/ipc.js";
import type { MessageKey } from "../src/messages.js";

// The Terminal tab's file sidebar.
//
// One per tab, on the left, following whichever pane has the focus — not
// one per pane: a tab split three ways would otherwise be mostly tree, and
// three toggles to manage. What it knows is small on purpose: a pane key
// and a path. It never listens to a shell and never opens anything itself;
// the tab hands it a `list` and a `choose` and it draws what comes back.
//
// It does not watch the filesystem either — a recursive watch on a large
// repository costs more than the sidebar is worth, and differs on every
// OS. It re-reads instead: on every prompt (a command just finished, the
// likeliest moment for files to have changed) and every few seconds while
// it is on screen, keeping open folders open, and touching no row whose
// listing did not change.
//
// This file is the join between three things built separately: the pane's
// `onCwd`, the main process's `listDir`, and the tree in file-tree.ts. Its
// whole job is to keep them attributed to the right shell.

export type TerminalExplorerHooks = {
  /** One directory's immediate children, for the pane that asked. */
  list: (paneKey: string, path: string) => Promise<DirEntry[]>;
  /** A file was chosen, in that pane's shell. */
  choose: (paneKey: string, path: string) => void;
  /** The sidebar's writes, and the strings to offer them with. Absent, the
   *  sidebar is read-only: no toolbar, no menu. Every path is checked by
   *  main against the pane's project; these only carry the request. */
  writes?: {
    create: (
      paneKey: string,
      parent: string,
      name: string,
      kind: EntryKind,
    ) => Promise<FileOpResult>;
    rename: (paneKey: string, path: string, newName: string) => Promise<FileOpResult>;
    trash: (paneKey: string, path: string) => Promise<FileOpResult>;
    t: (key: MessageKey) => string;
  };
  /** How often an on-screen sidebar re-reads; tests shorten or disable
   *  it. 0 turns the check off. */
  pollMs?: number;
};

/** The default re-read interval while the sidebar is on screen. A listing
 *  per open folder every few seconds is cheap; a sidebar that lags a
 *  `git checkout` by a few seconds is fine. */
const POLL_MS = 4000;

/** How long a refusal stays under the tree. */
const ERROR_MS = 4000;

const REFUSAL_KEYS: Record<Exclude<FileOpResult, { ok: true }>["reason"], MessageKey> = {
  exists: "explorerErrorExists",
  "invalid-name": "explorerErrorInvalidName",
  outside: "explorerErrorOutside",
  failed: "explorerErrorFailed",
};

export type TerminalExplorer = {
  element: HTMLElement;
  /** The focused pane changed, or its shell moved. */
  setRoot(paneKey: string, path: string): void;
  /** Reads the current root and every open folder again, keeping them
   *  open. The prompt and the on-screen check already do this; this is the
   *  palette's way to do it now. No-op when there is no root: a sidebar
   *  showing nothing has nothing to re-read. */
  refresh(): void;
  /** There is no directory to show any more — the pane it was following
   *  is gone. Empties it; the next root brings it back. */
  clear(): void;
  toggle(): void;
  isOpen(): boolean;
  dispose(): void;
};

/** Nothing in a sidebar is worth taking a terminal down for — the same
 *  discipline terminal-pane.ts and terminal-addons.ts follow. */
function attempt(work: () => void): void {
  try {
    work();
  } catch {
    // The terminal is untouched.
  }
}

export function createTerminalExplorer(
  host: HTMLElement,
  /** Same `home` the chip row is handed, from the `terminal:settings`
   *  payload — what the header collapses the root against. */
  home: string,
  hooks: TerminalExplorerHooks,
): TerminalExplorer {
  const element = document.createElement("div");
  element.className = "terminal-explorer";

  // Says which directory is on screen — nothing else did, and the tree
  // re-roots silently on every `cd`. Reuses terminal-chips.ts's own
  // $HOME collapse rather than a second copy of it.
  const header = document.createElement("div");
  header.className = "terminal-explorer-header";
  element.append(header);
  // Nothing to show until a shell has said where it is. A pane without
  // shell integration never reports a directory, and its tab stays exactly
  // what it was before this sidebar existed: no column, no listing, no
  // IPC call. The first root shows it; after that the toggle is the
  // user's, and a later `cd` never re-opens what they closed.
  element.hidden = true;
  host.append(element);

  /** The pane the tree is currently drawing, and where. Read by the
   *  tree's own `list` and `choose`, so a listing or a click can only ever
   *  be attributed to the shell the sidebar is rooted for — never to a
   *  pane that has since taken the focus, and never to none at all. */
  let rooted: { paneKey: string; path: string } | undefined;
  /** Whether the user has closed it. Separate from `hidden`, which is also
   *  true when there is simply nothing to show: a sidebar hidden for want
   *  of a directory comes back with the next one, and one the user closed
   *  does not. Only ever moved by a toggle that had something to toggle —
   *  see `toggle`. */
  let dismissed = false;
  let disposed = false;

  /** The one place visibility is decided, from the two things that decide
   *  it. Nothing else writes `hidden`. */
  function applyVisibility(): void {
    element.hidden = dismissed || rooted === undefined;
  }

  const writes = hooks.writes;

  // A refusal, under the tree, for a few seconds. Empty — and so adding
  // nothing to the sidebar's text — whenever there is nothing to say.
  const error = document.createElement("div");
  error.className = "terminal-explorer-error";
  error.setAttribute("role", "status");
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  function showResult(result: FileOpResult): void {
    if (errorTimer !== undefined) clearTimeout(errorTimer);
    if (result.ok || writes === undefined) {
      error.textContent = "";
      return;
    }
    error.textContent = writes.t(REFUSAL_KEYS[result.reason]);
    errorTimer = setTimeout(() => {
      error.textContent = "";
    }, ERROR_MS);
  }

  /** The open context menu's way out, if one is open. */
  let closeMenu: (() => void) | undefined;

  const tree = createFileTree({
    list: async (path) => {
      if (disposed || rooted === undefined) return [];
      const entries = await hooks.list(rooted.paneKey, path);
      // A listing that settles after dispose() must draw nothing: the tree
      // treats a failed list as "leave it", so no row is built for a view
      // that is gone (or, in tests, after its document is torn down).
      if (disposed) throw new Error("terminal explorer disposed");
      return entries;
    },
    choose: (path) => {
      if (disposed || rooted === undefined) return;
      hooks.choose(rooted.paneKey, path);
    },
    ...(writes === undefined ? {} : { menu: (target, x, y) => openMenu(target, x, y) }),
  });

  /** Runs one write for the pane the sidebar is rooted for, shows what came
   *  back, and re-reads. The pane is captured before the name is typed: a
   *  focus change while typing must not move the write to another shell. */
  async function perform(
    run: (paneKey: string) => Promise<FileOpResult | undefined>,
  ): Promise<void> {
    const current = rooted;
    if (disposed || current === undefined) return;
    let result: FileOpResult | undefined;
    try {
      result = await run(current.paneKey);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (disposed || result === undefined) return;
    showResult(result);
    await tree.reload();
  }

  function create(parent: string, kind: EntryKind): void {
    if (writes === undefined) return;
    void perform(async (paneKey) => {
      const name = await tree.edit({ kind: "create", parent, entry: kind });
      return name === undefined ? undefined : await writes.create(paneKey, parent, name, kind);
    });
  }

  function rename(path: string): void {
    if (writes === undefined) return;
    void perform(async (paneKey) => {
      const name = await tree.edit({ kind: "rename", path });
      return name === undefined ? undefined : await writes.rename(paneKey, path, name);
    });
  }

  function trash(path: string): void {
    if (writes === undefined) return;
    void perform((paneKey) => writes.trash(paneKey, path));
  }

  // The menu is built when it opens and removed when it closes, so a
  // closed menu leaves nothing behind in the document. Fixed-position on
  // the body: inside the sidebar it would be clipped by its overflow.
  function openMenu(target: FileTreeTarget, x: number, y: number): void {
    if (writes === undefined || rooted === undefined) return;
    closeMenu?.();
    const folder = target === undefined ? rooted.path : target.directory ? target.path : undefined;
    const items: Array<[MessageKey, () => void]> = [];
    if (folder !== undefined) {
      items.push(["explorerNewFile", () => create(folder, "file")]);
      items.push(["explorerNewFolder", () => create(folder, "directory")]);
    }
    if (target !== undefined) {
      items.push(["explorerRename", () => rename(target.path)]);
      items.push(["explorerTrash", () => trash(target.path)]);
    }

    const menu = document.createElement("div");
    menu.className = "terminal-explorer-menu";
    menu.setAttribute("role", "menu");
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    for (const [key, action] of items) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "terminal-explorer-menu-item";
      item.setAttribute("role", "menuitem");
      item.textContent = writes.t(key);
      if (key === "explorerTrash") item.classList.add("terminal-explorer-menu-item--danger");
      item.addEventListener("click", () => {
        closeMenu?.();
        action();
      });
      menu.append(item);
    }

    const onPointer = (event: Event): void => {
      if (!menu.contains(event.target as Node)) closeMenu?.();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeMenu?.();
    };
    closeMenu = () => {
      closeMenu = undefined;
      menu.remove();
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    document.body.append(menu);
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }

  // New file / New folder at the root, beside the header. The icons are
  // CSS; the buttons hold no text of their own, so the sidebar's text is
  // still exactly its header and its rows.
  if (writes !== undefined) {
    const actions = document.createElement("div");
    actions.className = "terminal-explorer-actions";
    for (const [key, kind] of [
      ["explorerNewFile", "file"],
      ["explorerNewFolder", "directory"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `terminal-explorer-action terminal-explorer-action--${kind}`;
      button.title = writes.t(key);
      button.setAttribute("aria-label", writes.t(key));
      button.addEventListener("click", () => {
        if (rooted !== undefined) create(rooted.path, kind);
      });
      actions.append(button);
    }
    element.append(actions);
  }
  element.append(tree.element);
  element.append(error);

  // A burst of prompts (a script, a held Enter) is one re-read, not one
  // per prompt.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleReload(): void {
    if (reloadTimer !== undefined) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      if (!disposed && rooted !== undefined) void tree.reload();
    }, 150);
  }

  const pollMs = hooks.pollMs ?? POLL_MS;
  const poll =
    pollMs > 0
      ? setInterval(() => {
          // Only while someone could be looking: a hidden sidebar, a
          // background tab or a minimised window reads nothing.
          if (disposed || element.hidden || !element.isConnected) return;
          if (document.visibilityState !== "visible") return;
          void tree.reload();
        }, pollMs)
      : undefined;

  return {
    element,

    setRoot(paneKey, path) {
      if (disposed) return;
      // The cwd event fires on every prompt, not only when the directory
      // changed — a shell printing its prompt where it already was
      // re-emits it. Without this, every prompt would re-list the whole
      // directory and throw away whatever the user had expanded. The pane
      // key is part of the comparison because a different pane in the same
      // directory is a different shell: its listing and its `choose` must
      // carry its own key.
      if (rooted?.paneKey === paneKey && rooted.path === path) {
        // The same shell where it already was: a command just finished.
        // Re-read in place rather than re-root — what is expanded stays
        // expanded, and rows whose listing did not change are left alone.
        scheduleReload();
        return;
      }
      rooted = { paneKey, path };
      applyVisibility();
      attempt(() => {
        header.textContent = formatCwd(path, home);
      });
      // The rows go before the new listing does, not when it answers.
      // FileTree leaves its container alone until its `list` resolves —
      // deliberately, so a failed listing never blanks the tree — but that
      // would leave the *previous* pane's rows on screen, clickable, for as
      // long as the new pane's listing takes: a click in that window would
      // hand `choose` one pane's path under another pane's key. A blank
      // column for one round trip is the honest thing to show instead.
      attempt(() => tree.element.replaceChildren());
      attempt(() => void tree.setRoot(path));
    },

    refresh() {
      if (disposed) return;
      const current = rooted;
      // Nothing rooted is nothing to re-list. The palette offers this
      // action before a pane's first prompt too, and it must do nothing
      // there rather than list some remembered directory.
      if (current === undefined) return;
      attempt(() => void tree.reload());
    },

    clear() {
      if (disposed) return;
      // Rooted for a shell that no longer exists — the pane it was
      // following was closed, and whatever took the focus has never said
      // where it is. Showing that dead shell's directory would be a
      // directory nobody is in.
      rooted = undefined;
      applyVisibility();
      attempt(() => {
        header.textContent = "";
      });
      attempt(() => tree.element.replaceChildren());
    },

    toggle() {
      // Nothing to show is nothing to toggle. Without this, a toggle that
      // changed nothing on screen — the palette offers the action before a
      // pane's first prompt, and again after a ⌘W that cleared the
      // sidebar — would still record a dismissal, and the next directory
      // would be swallowed: the sidebar would never open by itself again.
      // A toggle with no visible effect must have no later effect either.
      if (rooted === undefined) return;
      dismissed = !dismissed;
      applyVisibility();
    },

    isOpen() {
      return !element.hidden;
    },

    dispose() {
      disposed = true;
      if (poll !== undefined) clearInterval(poll);
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      if (errorTimer !== undefined) clearTimeout(errorTimer);
      closeMenu?.();
      // The rows' own click listeners die with the elements they are on;
      // `disposed` is what closes the window on a row a caller happens to
      // still hold, and on a `setRoot` from a pane whose disposal has not
      // reached its tab yet.
      element.remove();
      element.replaceChildren();
    },
  };
}
