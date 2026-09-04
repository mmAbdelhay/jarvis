import { createFileTree } from "./file-tree.js";
import type { DirEntry } from "../src/ipc.js";

// The Terminal tab's file sidebar.
//
// One per tab, on the left, following whichever pane has the focus — not
// one per pane: a tab split three ways would otherwise be mostly tree, and
// three toggles to manage. What it knows is small on purpose: a pane key
// and a path. It never listens to a shell, never watches a directory and
// never opens anything itself; the tab hands it a `list` and a `choose`
// and it draws what comes back.
//
// This file is the join between three things built separately: the pane's
// `onCwd`, the main process's `listDir`, and the tree in file-tree.ts. Its
// whole job is to keep them attributed to the right shell.

export type TerminalExplorerHooks = {
  /** One directory's immediate children, for the pane that asked. */
  list: (paneKey: string, path: string) => Promise<DirEntry[]>;
  /** A file was chosen, in that pane's shell. */
  choose: (paneKey: string, path: string) => void;
};

export type TerminalExplorer = {
  element: HTMLElement;
  /** The focused pane changed, or its shell moved. */
  setRoot(paneKey: string, path: string): void;
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
  hooks: TerminalExplorerHooks,
): TerminalExplorer {
  const element = document.createElement("div");
  element.className = "terminal-explorer";
  // Nothing to show until a shell has said where it is. A pane without
  // shell integration never reports a directory, and its tab stays exactly
  // what it was before this sidebar existed: no column, no listing, no
  // IPC call. The first root opens it; after that the toggle is the
  // user's, and a later `cd` never re-opens what they closed.
  element.hidden = true;
  host.append(element);

  /** The pane the tree is currently drawing, and where. Read by the
   *  tree's own `list` and `choose`, so a listing or a click can only ever
   *  be attributed to the shell the sidebar is rooted for — never to a
   *  pane that has since taken the focus, and never to none at all. */
  let rooted: { paneKey: string; path: string } | undefined;
  let disposed = false;

  const tree = createFileTree({
    list: async (path) => {
      if (disposed || rooted === undefined) return [];
      return await hooks.list(rooted.paneKey, path);
    },
    choose: (path) => {
      if (disposed || rooted === undefined) return;
      hooks.choose(rooted.paneKey, path);
    },
  });
  element.append(tree.element);

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
      if (rooted?.paneKey === paneKey && rooted.path === path) return;
      const first = rooted === undefined;
      rooted = { paneKey, path };
      // Opening on the *first* root only: a sidebar the user has closed
      // stays closed through every later `cd`.
      if (first) element.hidden = false;
      attempt(() => void tree.setRoot(path));
    },

    toggle() {
      element.hidden = !element.hidden;
    },

    isOpen() {
      return !element.hidden;
    },

    dispose() {
      disposed = true;
      // The rows' own click listeners die with the elements they are on;
      // `disposed` is what closes the window on a row a caller happens to
      // still hold, and on a `setRoot` from a pane whose disposal has not
      // reached its tab yet.
      element.remove();
      element.replaceChildren();
    },
  };
}
