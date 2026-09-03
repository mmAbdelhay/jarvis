import type { WorkspaceTab } from "@jarvis/core";
import { enhanceTerminal } from "./terminal-addons.js";
import { attachCompletion, type Completion } from "./terminal-completion.js";
import { createPane, type TerminalPane } from "./terminal-pane.js";

// The Workspace's Terminal tabs.
//
// A terminal tab has no hosted view (see BrowserHost.openTerminal): its
// shell runs under a pty in the main process and its screen is drawn right
// here, in the renderer's own DOM, over the same slot a hosted page would
// occupy. One xterm instance per tab, kept alive for as long as the tab is —
// so switching tabs is showing and hiding elements, not replaying a stream,
// and scrollback survives without anyone having to store it.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

/** The outer element belongs to the Workspace — one per tab, shown and
 *  hidden as tabs change — and the pane is what draws inside it. */
type Pane = { element: HTMLElement; pane: TerminalPane };

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

  window.jarvis.onTerminalData((tabId, chunk) => {
    panes.get(tabId)?.pane.write(chunk);
  });

  window.jarvis.onTerminalExit((tabId, code) => {
    // The tab stays open: its scrollback is usually the reason you were
    // there. The shell is gone, and saying so beats a terminal that has
    // silently stopped responding. It goes straight to the live terminal:
    // this is Jarvis speaking, not the pty, so it is no command's output and
    // has no business inside a block.
    panes
      .get(tabId)
      ?.pane.terminal.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
  });
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
    pane.pane.dispose();
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

  if (showing !== undefined) ensurePane(showing, selectedProject, host);
  for (const [tabId, pane] of panes) pane.element.hidden = tabId !== showing;

  if (showing === undefined) return;
  const pane = panes.get(showing);
  // The host was hidden until a moment ago, so this is the first point at
  // which the pane has a real size to be laid out at.
  pane?.pane.refit();
  pane?.pane.focus();
}

function ensurePane(tabId: string, project: string, host: HTMLElement): Pane {
  const existing = panes.get(tabId);
  if (existing !== undefined) return existing;

  const element = document.createElement("div");
  element.className = "workspace-terminal-pane";
  host.append(element);

  // Completion needs the pane's terminal to exist before it can be built,
  // but the editor's own keystrokes need completion consulted from inside
  // createPane, before completion can exist — so the pane gets a forward
  // reference, filled in once attachCompletion has actually run, exactly
  // the way `completion` itself already gets reassigned below.
  let completion: Completion = { handleKey: () => true };

  // The tab's terminal: frozen blocks over a live xterm when the shell's
  // integration is on, and today's bare terminal when it is not. Keystrokes,
  // the cell grid and the shell's buffered prologue are all its business;
  // what stays here is everything that needs to know which tab this is.
  const view = createPane(element, {
    // Every keystroke verbatim, control bytes included — that is what makes
    // Ctrl-C, arrows and Escape work rather than only plain text.
    sendInput: (data) => void window.jarvis.sendTerminalInput(tabId, data),
    resize: (cols, rows) => void window.jarvis.resizeTerminal(tabId, cols, rows),
    // Whatever the shell printed before this pane existed — its prompt,
    // usually. Buffered by the shell manager exactly for this gap.
    attach: () => window.jarvis.attachTerminal(tabId),
    settings: terminalSettings,
    // What the command editor's arrows walk: Jarvis's own command log,
    // never zsh's line editor. Guarded because a preload without the
    // channel must still be a terminal, with arrows that do nothing rather
    // than an exception at every prompt.
    history: async () => {
      try {
        return await window.jarvis.terminalHistory(tabId, HISTORY_LIMIT);
      } catch {
        return [];
      }
    },
    // The dropdown's first look at a keystroke over the editor — xterm's
    // own custom key handler below never sees these, since the event
    // targets the editor's own <textarea>, not xterm's.
    interceptKey: (event) => completion.handleKey(event),
  });
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
  const editorCompletionHooks = terminalSettings.inputEditor
    ? {
        readInput: () => view.readInput(),
        applyInput: (line: string) => view.applyInput(line),
        // Left-aligned to the editor's own box, one editor-height below its
        // top — not a caret cell, since the buffer never moves while the
        // editor is live to compute one from.
        anchor: () => {
          const editorEl = view.editorElement();
          if (editorEl === undefined) return { x: 0, y: 0 };
          const editorBox = editorEl.getBoundingClientRect();
          const hostBox = element.getBoundingClientRect();
          return { x: editorBox.left - hostBox.left, y: editorBox.bottom - hostBox.top };
        },
      }
    : {};
  try {
    completion = attachCompletion(terminal, element, {
      suggest: (input) => window.jarvis.suggestCompletions(tabId, input),
      sendInput: (data) => void window.jarvis.sendTerminalInput(tabId, data),
      ...editorCompletionHooks,
    });
  } catch {
    // No dropdown. The shell is untouched.
  }

  // Addons, key bindings and the find bar — shared with the Session view's
  // terminal so the two behave identically. After open(): WebGL needs a real
  // element to attach a context to.
  enhanceTerminal(terminal, element, {
    interceptKey: (event) => completion.handleKey(event),
    sendInput: (data) => void window.jarvis.sendTerminalInput(tabId, data),
    // A link opens as an ordinary browser tab in the same project, which is
    // what puts it through normalizeInput and the app's navigation rules
    // instead of handing an arbitrary string to the OS.
    openLink: (url) => void window.jarvis.openTab(project, url),
    // Undefined with blocks switched off — createPane leaves its own
    // blockNav undefined in that case, and the key handler's guards make
    // that mean "behave exactly as today" rather than claiming ⌘↑/⌘↓/⌘⇧F
    // and doing nothing with them.
    blockNav: view.blockNav,
  });

  const pane: Pane = { element, pane: view };
  panes.set(tabId, pane);

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => view.refit()).observe(element);
  }

  return pane;
}
