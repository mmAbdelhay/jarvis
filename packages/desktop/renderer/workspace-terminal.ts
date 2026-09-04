import type { WorkspaceTab } from "@jarvis/core";
import { LOGIN_TERMINAL_DETAIL } from "../src/login-terminal.js";
import { enhanceTerminal, handleSplitKey, type SplitKeys } from "./terminal-addons.js";
import { attachCompletion, type Completion } from "./terminal-completion.js";
import { createTerminalExplorer, type TerminalExplorer } from "./terminal-explorer.js";
import { createPane, type TerminalPane } from "./terminal-pane.js";
import { createSplitTree, type SplitTree } from "./terminal-splits.js";

// The Workspace's Terminal tabs.
//
// A terminal tab has no hosted view (see BrowserHost.openTerminal): its
// shell runs under a pty in the main process and its screen is drawn right
// here, in the renderer's own DOM, over the same slot a hosted page would
// occupy. One tree of panes per tab, kept alive for as long as the tab is —
// so switching tabs is showing and hiding elements, not replaying a stream,
// and scrollback survives without anyone having to store it.
//
// A tab holds a tree rather than a single pane because a tab can be split
// (see terminal-splits.ts). Every leaf is a whole pane with a shell of its
// own, keyed "<tabId>:<paneId>" — and a tab nobody has split is one leaf
// keyed by the bare tab id, which is exactly what it was before splits
// existed, down to the shell key.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

/** The outer element belongs to the Workspace — one per tab, shown and
 *  hidden as tabs change — and the tree is what draws inside it. */
type Pane = { element: HTMLElement; tree: SplitTree; explorer: TerminalExplorer };

/** Which shell each pane is drawing. A WeakMap rather than a lookup table
 *  the tree would have to keep in step: a pane that has been closed is
 *  simply no longer among `tree.panes()`, so a key can never resolve to a
 *  pane that is gone. */
const paneKeys = new WeakMap<TerminalPane, string>();

/** How many commands the command editor's arrows may walk back through.
 *  Long enough to reach this morning's command, short enough that a prompt
 *  costs one small read. */
const HISTORY_LIMIT = 200;

const panes = new Map<string, Pane>();
let wired = false;

/** How terminals behave: read once for the whole module rather than once per
 *  pane, because a change to jarvis.yaml takes effect on restart anyway.
 *  Until it resolves — and if it never does — a pane is built with these,
 *  which are the terminal Jarvis shipped before blocks existed and so the
 *  right thing to fall back to. */
let terminalSettings = { blocks: false, inputEditor: false, notifyAfterSeconds: 0, home: "" };
try {
  void window.jarvis
    .terminalSettings()
    .then((settings) => {
      terminalSettings = settings;
    })
    .catch(() => {
      // Today's terminal. Nothing else about the tab is affected.
    });
} catch {
  // A preload without the channel — the same fallback.
}

/** Called once, from initWorkspace. Subscribes to the two streams main
 *  pushes; every pane created later reads from the same subscription rather
 *  than adding one of its own. */
export function initWorkspaceTerminals(): void {
  if (wired) return;
  wired = true;

  window.jarvis.onTerminalData((paneKey, chunk) => {
    paneFor(paneKey)?.write(chunk);
  });

  window.jarvis.onTerminalExit((paneKey, code) => {
    // The tab stays open: its scrollback is usually the reason you were
    // there. The shell is gone, and saying so beats a terminal that has
    // silently stopped responding. It goes straight to the live terminal:
    // this is Jarvis speaking, not the pty, so it is no command's output and
    // has no business inside a block.
    paneFor(paneKey)?.terminal.write(
      `\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`,
    );
  });
}

/**
 * The pane drawing `paneKey`'s shell, or undefined for a shell this window
 * has no pane for.
 *
 * The pty stream is routed by shell key, never by tab: a split tab has one
 * shell per pane, and putting one pane's output into another's would be the
 * worst thing this module could do. The tab id is the part before the first
 * colon — tab ids have none of their own (see WorkspaceTabs' `tab-<n>`).
 */
function paneFor(paneKey: string): TerminalPane | undefined {
  const colon = paneKey.indexOf(":");
  const entry = panes.get(colon === -1 ? paneKey : paneKey.slice(0, colon));
  return entry?.tree.panes().find((pane) => paneKeys.get(pane) === paneKey);
}

/**
 * Shows the active tab's terminal and hides every other, creating a pane
 * the first time a tab needs one. Driven entirely by workspace state: the
 * renderer never tracks "which terminal is open" separately from which tab
 * is active.
 */
export function renderWorkspaceTerminals(
  tabs: WorkspaceTab[],
  activeTabId: string | undefined,
  selectedProject: string,
): void {
  const host = $("workspace-terminal");
  const live = new Set(tabs.filter((tab) => tab.kind === "terminal").map((tab) => tab.id));

  // A tab that is gone takes its terminal with it. The shell is already
  // being reaped by main's own close handler.
  for (const [tabId, pane] of panes) {
    if (live.has(tabId)) continue;
    // Every pane of the tab, not only the one that was focused: main's own
    // close handler reaps the tab's shells and its splits' with them.
    pane.tree.dispose();
    pane.explorer.dispose();
    pane.element.remove();
    panes.delete(tabId);
  }

  const active = tabs.find((tab) => tab.id === activeTabId);
  // The active tab may belong to a project the user has since switched away
  // from: hideAll() leaves it active in the store so that switching back
  // restores it, and main hides the hosted views behind a flag of its own.
  // A terminal is the renderer's own DOM, so it applies the same rule here
  // rather than going on showing another project's shell.
  const showing =
    active?.kind === "terminal" && active.project === selectedProject ? active.id : undefined;
  host.hidden = showing === undefined;

  // The AWS login tab is the one terminal in Jarvis drawn without blocks —
  // see paneSettings.
  if (showing !== undefined) {
    ensurePane(showing, selectedProject, host, active?.detail === LOGIN_TERMINAL_DETAIL);
  }
  for (const [tabId, pane] of panes) pane.element.hidden = tabId !== showing;

  if (showing === undefined) return;
  const pane = panes.get(showing);
  if (pane === undefined) return;
  // The host was hidden until a moment ago, so this is the first point at
  // which the panes have a real size to be laid out at.
  for (const leaf of pane.tree.panes()) leaf.refit();
  pane.tree.focused().focus();
}

/**
 * How this tab's panes behave.
 *
 * Every terminal in Jarvis gets the configured settings, with exactly one
 * deliberate exception: the AWS login tab (see LOGIN_TERMINAL_DETAIL). That
 * tab is opened by Jarvis itself to run one command — `saml2aws login` —
 * and is closed once the login is done; there is never a second command, so
 * a block would be a frame around the only thing on screen. It is the one
 * place this design opts out of blocks, and it opts out here rather than
 * anywhere deeper so that nothing in the pane itself has to know why.
 */
function paneSettings(isLoginTerminal: boolean): typeof terminalSettings {
  return isLoginTerminal ? { ...terminalSettings, blocks: false } : terminalSettings;
}

function ensurePane(
  tabId: string,
  project: string,
  host: HTMLElement,
  isLoginTerminal: boolean,
): Pane {
  const existing = panes.get(tabId);
  if (existing !== undefined) return existing;

  const element = document.createElement("div");
  element.className = "workspace-terminal-pane";
  host.append(element);

  // The tree is built from the panes it is given, so its own actions can
  // only be wired after it exists — and they are only ever called from a
  // keystroke, long after this returns.
  let tree: SplitTree | undefined;
  const splitKeys: SplitKeys = {
    split: (direction) => tree?.split(direction),
    // No tree yet is "no other pane", which sends ⌘W to the tab — the same
    // answer as a tab that was never split.
    closeFocused: () => tree?.closeFocused() ?? false,
    focus: (delta) => tree?.focus(delta),
    closeTab: () => void window.jarvis.closeTab(tabId),
  };

  // The tab's file sidebar, on the left — one for the whole tab, however
  // many panes it is split into, following whichever of them has the
  // focus. Appended before the tree so it sits left of the panes.
  const explorer = createTerminalExplorer(element, terminalSettings.home, {
    // Guarded: a preload without the channel leaves a sidebar with nothing
    // to draw, never a terminal that throws. The pane key travels with
    // every listing rather than being assumed from the tab because it is
    // what tells main which shell asked: main resolves the path against
    // that pane's own working directory, and uses it to pick which
    // configured project the request belongs to. The containment check
    // itself is against that project's directory, not against the cwd —
    // see ipc.ts's listDir.
    list: async (paneKey, path) => {
      try {
        return await window.jarvis.listTerminalDir(paneKey, path);
      } catch {
        return [];
      }
    },
    // Fire-and-forget, exactly like `list` above: main does the whole of
    // "open this file" — containment, code-server, the tab itself — and
    // never rejects, so there is nothing here to await or to show. A
    // refusal (outside the project, no editor integration, code-server
    // failing to start) leaves the terminal exactly as it was, with no
    // dialog over it.
    choose: (paneKey, path) => {
      try {
        void window.jarvis.openTerminalFile(paneKey, path).catch(() => {});
      } catch {
        // A preload without the channel. Same fallback as `list` above.
      }
    },
  });

  /** Where each pane's shell last said it was. Read on a focus change:
   *  the sidebar follows the newly focused pane, and that pane's prompt
   *  may be minutes old. */
  const lastCwd = new Map<string, string>();

  const built = createSplitTree(
    element,
    (paneKey, paneHost) =>
      makePane(
        tabId,
        paneKey,
        project,
        paneHost,
        splitKeys,
        paneSettings(isLoginTerminal),
        // Only the focused pane's directory drives the sidebar: a
        // background pane running `cd` must never re-root the tree under
        // someone reading it in another pane.
        (path) => {
          lastCwd.set(paneKey, path);
          if (focusedKey() === paneKey) explorer.setRoot(paneKey, path);
        },
        // The sidebar's only way out: no chord, one palette action.
        () => explorer.toggle(),
        // And its only way to notice a file a command just created,
        // deleted or renamed: nothing watches the filesystem, and a root
        // that has not changed is not re-listed.
        () => explorer.refresh(),
      ),
    tabId,
    {
      onFocus: (paneKey) => {
        const path = lastCwd.get(paneKey);
        // A pane that has never said where it is — a shell with no
        // integration, or one that has not drawn its first prompt yet —
        // leaves nothing honest to show. Going on showing the previous
        // pane's directory would be worst of all after a ⌘W, where that
        // pane's shell is gone and every listing under its key would fall
        // back to the tab's own.
        if (path === undefined) explorer.clear();
        else explorer.setRoot(paneKey, path);
      },
    },
  );
  tree = built;

  /** The focused pane's shell key. Resolved through the same WeakMap the
   *  pty stream is routed by, so it can never name a pane that is gone. */
  function focusedKey(): string | undefined {
    return tree === undefined ? undefined : paneKeys.get(tree.focused());
  }

  const pane: Pane = { element, tree: built, explorer };
  panes.set(tabId, pane);
  return pane;
}

/**
 * One leaf of a tab's tree: a whole terminal pane, with its own blocks, its
 * own editor and its own autocomplete, talking to the shell keyed
 * `paneKey`. Nothing here is conditional on whether the pane is the tab's
 * first or one split off it — the only difference between them is the key.
 */
function makePane(
  tabId: string,
  paneKey: string,
  project: string,
  element: HTMLElement,
  splitKeys: SplitKeys,
  settings: typeof terminalSettings,
  onCwd: (path: string) => void,
  toggleExplorer: () => void,
  refreshExplorer: () => void,
): TerminalPane {
  // A split pane's shell has to exist before the pane can attach to it, so
  // the attach below waits on this. The tab's own pane has had a shell
  // since main opened the tab.
  const started = startShell(tabId, paneKey);

  // Where this pane's shell last said it was — the same OSC 7 report that
  // drives `onCwd` and the chip row, kept here too because autocomplete
  // needs it read fresh at every keystroke, not only on a prompt. `main`
  // only ever knows where the shell *started*; without this, completions
  // would keep answering for that directory forever, the very bug this
  // wiring exists to fix. `undefined` until the first prompt — main falls
  // back to the start directory for that case on its own.
  let livePath: string | undefined;

  // Completion needs the pane's terminal to exist before it can be built,
  // but the editor's own keystrokes need completion consulted from inside
  // createPane, before completion can exist — so the pane gets a forward
  // reference, filled in once attachCompletion has actually run, exactly
  // the way `completion` itself already gets reassigned below.
  let completion: Completion = { handleKey: () => true, close: () => {} };

  // The pane's own first look at a keystroke: the split chords, then the
  // autocomplete dropdown. It is passed both to the pane (the editor's
  // path) and to enhanceTerminal (xterm's), because those are two
  // different events — while the command editor is visible a keystroke
  // targets its field and never reaches xterm at all — and the split
  // chords have to work at either.
  const interceptKey = (event: KeyboardEvent): boolean =>
    handleSplitKey(event, splitKeys) && completion.handleKey(event);

  // The pane's terminal: frozen blocks over a live xterm when the shell's
  // integration is on, and today's bare terminal when it is not. Keystrokes,
  // the cell grid and the shell's buffered prologue are all its business;
  // what stays here is everything that needs to know which shell this is.
  const view = createPane(element, {
    // Every keystroke verbatim, control bytes included — that is what makes
    // Ctrl-C, arrows and Escape work rather than only plain text.
    sendInput: (data) => void window.jarvis.sendTerminalInput(paneKey, data),
    resize: (cols, rows) => void window.jarvis.resizeTerminal(paneKey, cols, rows),
    // A `Notification` this environment lacks, or has never been granted
    // permission for, throws — and this is the one call in the pane's
    // whole chain of side effects allowed to swallow that, since nothing
    // here reaches the pty or the DOM the terminal itself depends on.
    notify: (title, body) => {
      try {
        new Notification(title, { body });
      } catch {
        // Notification unsupported or denied: no less a working terminal.
      }
    },
    // Whatever the shell printed before this pane existed — its prompt,
    // usually. Buffered by the shell manager exactly for this gap, and
    // waited for so a split pane never attaches to a shell main has not
    // started yet: attaching to an unknown key registers no listener at
    // all, and the pane would stay blank for good.
    attach: () =>
      started === undefined
        ? window.jarvis.attachTerminal(paneKey)
        : started.then(() => window.jarvis.attachTerminal(paneKey)),
    settings,
    // What the command editor's arrows walk: Jarvis's own command log,
    // never zsh's line editor. Guarded because a preload without the
    // channel must still be a terminal, with arrows that do nothing rather
    // than an exception at every prompt.
    history: async () => {
      try {
        return await window.jarvis.terminalHistory(paneKey, HISTORY_LIMIT);
      } catch {
        return [];
      }
    },
    // What ⌘P's "Run workflow…" offers — this project's saved workflows.
    // Guarded the same way `history` is: a channel that fails leaves the
    // action with nothing to offer, never a terminal that throws.
    workflows: async () => {
      try {
        return await window.jarvis.terminalWorkflows(project);
      } catch {
        return [];
      }
    },
    // The chip row's data, read fresh on every cwd event. Guarded the same
    // way `history` and `workflows` are: a channel that fails (or a preload
    // without it) leaves the row showing whatever it already had rather
    // than throwing into the pane.
    chips: async (path) => {
      try {
        // The pane's live directory travels with the request: main's own
        // record of where a shell is was written when the shell started
        // and never again, so after a `cd` it would answer for the wrong
        // repository — see TerminalHandlers.chips.
        return await window.jarvis.terminalChips(paneKey, path);
      } catch {
        return undefined;
      }
    },
    interceptKey,
    // The palette's split right / split down / close pane — the same tree
    // handleSplitKey already acts on for the app's own ⌘D/⌘⇧D/⌘W chords.
    splitKeys,
    // The two AI actions' only route to the brain. window.jarvis.terminalAi
    // never rejects (main resolves every failure, including no brain
    // configured, to ""), so this needs no guard of its own.
    terminalAi: (kind, text) => window.jarvis.terminalAi(kind, text),
    // So the palette can hide a suggestion list left showing from
    // mid-typing before it opens over the same pane.
    closeCompletion: () => completion.close(),
    // Where this pane's shell is, as of the prompt it is about to draw —
    // what the tab's file sidebar follows, and now also what autocomplete
    // reads before it asks main for anything.
    onCwd: (path) => {
      livePath = path;
      onCwd(path);
    },
    // "Toggle file sidebar" in the pane's own palette. The sidebar belongs
    // to the tab, not to the pane, so every pane's action toggles the same
    // one — which is the point: whichever pane you are in can dismiss it.
    toggleExplorer,
    // "Refresh file sidebar" in the same palette, and the sidebar's only
    // refresh trigger besides a `cd` and expanding a folder.
    refreshExplorer,
  });
  paneKeys.set(view, paneKey);
  const terminal = view.terminal;

  // Autocomplete: a dropdown under the cursor, completing from this user's
  // own shell history. Guarded because it is an enhancement and never a
  // requirement — a terminal that could not wire it must still be a
  // terminal, which is the same rule the addon stack follows. Its key
  // handling goes through enhanceTerminal rather than being attached
  // separately: xterm keeps only one custom key handler.
  //
  // readInput/applyInput/anchor go in only when the pane actually has an
  // editor — with `inputEditor` off, the pane's own readInput/applyInput/
  // editorElement always read as "no editor" anyway, but passing them
  // regardless would still hand attachCompletion an `anchor` hook, and an
  // anchor hook changes how the dropdown positions itself even over a bare
  // terminal. Today's cell-under-the-cursor placement has to stay exactly
  // what it was for a pane that never asked for an editor.
  const editorCompletionHooks = settings.inputEditor
    ? {
        readInput: () => view.readInput(),
        applyInput: (line: string) => view.applyInput(line),
        // Left-aligned to the editor's own box, and handing over its
        // vertical span — not a caret cell, since the buffer never moves
        // while the editor is live to compute one from. Direction (above
        // the box or below it) is attachCompletion's call, made from the
        // room actually available in `element`.
        anchor: () => {
          const editorEl = view.editorElement();
          if (editorEl === undefined) return { x: 0, top: 0, bottom: 0 };
          const editorBox = editorEl.getBoundingClientRect();
          const hostBox = element.getBoundingClientRect();
          return {
            x: editorBox.left - hostBox.left,
            top: editorBox.top - hostBox.top,
            bottom: editorBox.bottom - hostBox.top,
          };
        },
      }
    : {};
  try {
    completion = attachCompletion(terminal, element, {
      // The pane's own key, never the tab's: main resolves a split's cwd
      // through the same map it resolves the tab's, so a pane in a split
      // completes against the directory its own shell is in. `livePath`
      // travels alongside it for the same reason it travels with `chips`
      // — main's own record is only ever the shell's *starting* directory.
      suggest: (input) => window.jarvis.suggestCompletions(paneKey, input, livePath),
      sendInput: (data) => void window.jarvis.sendTerminalInput(paneKey, data),
      ...editorCompletionHooks,
    });
  } catch {
    // No dropdown. The shell is untouched.
  }

  // Addons, key bindings and the find bar — shared with the Session view's
  // terminal so the two behave identically. After open(): WebGL needs a real
  // element to attach a context to.
  enhanceTerminal(terminal, element, {
    interceptKey,
    sendInput: (data) => void window.jarvis.sendTerminalInput(paneKey, data),
    // A link opens as an ordinary browser tab in the same project, which is
    // what puts it through normalizeInput and the app's navigation rules
    // instead of handing an arbitrary string to the OS.
    openLink: (url) => void window.jarvis.openTab(project, url),
    // Undefined with blocks switched off — createPane leaves its own
    // blockNav undefined in that case, and the key handler's guards make
    // that mean "behave exactly as today" rather than claiming ⌘↑/⌘↓/⌘⇧F
    // and doing nothing with them.
    blockNav: view.blockNav,
    // ⌘P, claimed in every pane state — see terminal-addons.ts's own note
    // on why this one, unlike ^R, is never gated on the editor or on
    // whether something is running.
    openPalette: () => view.openPalette(),
  });

  // The pane's own slot, which a divider drag or a sibling's closing
  // resizes as well as the window does.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => view.refit()).observe(element);
  }

  return view;
}

/**
 * Starts the shell for a pane split off `tabId`, in the tab's own
 * directory. The tab's first pane already has one — main started it when
 * it opened the tab — and gets undefined, so that pane attaches exactly as
 * it did before splits existed, on the same tick.
 *
 * Never rejects: a split whose shell could not be started leaves a pane
 * that draws nothing, which is a great deal better than an exception in
 * the middle of a terminal.
 */
function startShell(tabId: string, paneKey: string): Promise<void> | undefined {
  if (paneKey === tabId) return undefined;
  try {
    // Everything after the tab id and its colon — see createSplitTree,
    // which is what composed the key.
    return Promise.resolve(window.jarvis.splitTerminal(tabId, paneKey.slice(tabId.length + 1))).catch(
      () => undefined,
    );
  } catch {
    // A preload without the channel.
    return Promise.resolve();
  }
}
