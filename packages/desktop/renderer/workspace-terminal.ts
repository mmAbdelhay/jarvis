import type { WorkspaceTab } from "@jarvis/core";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { Terminal } from "./vendor/xterm.mjs";

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

/** Matches the Session view's terminal: same scrollback, same reasoning —
 *  the scrollback is the record of what you did. */
const SCROLLBACK_LINES = 20_000;

/** The dashboard's palette, restated as values because xterm.js paints to a
 *  canvas and cannot inherit CSS. Kept identical to session-view.ts's THEME:
 *  the two terminals are the same surface in the user's eyes and must not
 *  drift apart visually. */
const THEME = {
  background: "#060a0f",
  foreground: "#e6f3f8",
  cursor: "#45c8dc",
  cursorAccent: "#060a0f",
  selectionBackground: "#1c3f49",
  black: "#0b1219",
  red: "#d9645a",
  green: "#5fb87a",
  yellow: "#d9a85a",
  blue: "#45c8dc",
  magenta: "#a97fd0",
  cyan: "#7ddced",
  white: "#cfe4ec",
  brightBlack: "#5c7484",
  brightRed: "#e8837a",
  brightGreen: "#7fd398",
  brightYellow: "#efc47c",
  brightBlue: "#7ddced",
  brightMagenta: "#c3a0e4",
  brightWhite: "#ffffff",
};

type Pane = { element: HTMLElement; terminal: Terminal; fit: FitAddon };

const panes = new Map<string, Pane>();
let wired = false;

/** Called once, from initWorkspace. Subscribes to the two streams main
 *  pushes; every pane created later reads from the same subscription rather
 *  than adding one of its own. */
export function initWorkspaceTerminals(): void {
  if (wired) return;
  wired = true;

  window.jarvis.onTerminalData((tabId, chunk) => {
    panes.get(tabId)?.terminal.write(chunk);
  });

  window.jarvis.onTerminalExit((tabId, code) => {
    // The tab stays open: its scrollback is usually the reason you were
    // there. The shell is gone, and saying so beats a terminal that has
    // silently stopped responding.
    panes.get(tabId)?.terminal.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
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
    pane.terminal.dispose();
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

  if (showing !== undefined) ensurePane(showing, host);
  for (const [tabId, pane] of panes) pane.element.hidden = tabId !== showing;

  if (showing === undefined) return;
  const pane = panes.get(showing);
  // The host was hidden until a moment ago, so this is the first point at
  // which the pane has a real size to be laid out at.
  refit(pane);
  pane?.terminal.focus();
}

function ensurePane(tabId: string, host: HTMLElement): Pane {
  const existing = panes.get(tabId);
  if (existing !== undefined) return existing;

  const element = document.createElement("div");
  element.className = "workspace-terminal-pane";
  host.append(element);

  const terminal = new Terminal({
    scrollback: SCROLLBACK_LINES,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.35,
    theme: THEME,
    cursorBlink: true,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);

  // Every keystroke verbatim, control bytes included — that is what makes
  // Ctrl-C, arrows and Escape work rather than only plain text.
  terminal.onData((data) => void window.jarvis.sendTerminalInput(tabId, data));
  // The pty's size has to track the pane's, or a full-screen program draws
  // to a width that does not exist.
  terminal.onResize(({ cols, rows }) => void window.jarvis.resizeTerminal(tabId, cols, rows));

  const pane: Pane = { element, terminal, fit };
  panes.set(tabId, pane);

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => refit(pane)).observe(element);
  }

  // Whatever the shell printed before this pane existed — its prompt,
  // usually. Buffered by the shell manager exactly for this gap.
  void window.jarvis.attachTerminal(tabId).then((buffered) => {
    if (buffered !== "") terminal.write(buffered);
  });

  return pane;
}

function refit(pane: Pane | undefined): void {
  if (pane === undefined) return;
  // A pane with no layout yet (hidden, or the window minimised) measures as
  // zero and would make the addon throw.
  if (pane.element.clientWidth === 0 || pane.element.clientHeight === 0) return;
  try {
    pane.fit.fit();
  } catch {
    // A fit racing a layout change is not worth surfacing; the next
    // observation corrects it.
  }
}
