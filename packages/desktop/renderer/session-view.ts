import type { Session, SessionOutput } from "@jarvis/core";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { showView } from "./changes.js";
import { detectLanguage } from "./format.js";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { Terminal } from "./vendor/xterm.mjs";

// The Session view: one agent process's real terminal.
//
// The agent runs under a pty (see platform/src/pty.ts) and draws a full
// terminal UI, so this is a genuine terminal emulator rather than a log
// pane — every byte the agent writes goes to xterm.js untouched, and every
// keystroke goes back to the pty untouched. Nothing in here parses or
// rewrites the stream: an agent's own UI owns what the session looks like,
// which is the whole point of running it this way.

const $ = (id: string): HTMLElement | null => document.getElementById(id);

/**
 * Scrollback in lines. Generous because the transcript is the record of
 * what an agent did, and a long run's early decisions are exactly what you
 * scroll back for.
 */
const SCROLLBACK_LINES = 20_000;

/**
 * Matches the dashboard's palette (index.html's :root custom properties).
 * Declared here rather than read from CSS because xterm.js paints to a
 * canvas and takes its colours as values, not as inherited style.
 */
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

let terminal: Terminal | undefined;
let fit: FitAddon | undefined;
let currentId: string | undefined;
/** Guards against sending a resize before a terminal has been opened. */
let attached = false;

/** Which session the terminal is showing, if any. */
export function openSessionId(): string | undefined {
  return currentId;
}

/**
 * Tells the main process where speech should go: into this session's
 * terminal while its view is open, back to the brain once it is left.
 * Called on every view change rather than inferred, because the main
 * process is the one holding the microphone and has no idea what is on
 * screen.
 */
function setVoiceTarget(sessionId: string | undefined): void {
  void window.jarvis.setVoiceTarget(sessionId);
  renderVoiceTarget(sessionId !== undefined, false);
}

/** Called by app.ts when the user navigates away from the Session view. */
export function releaseVoice(): void {
  setVoiceTarget(undefined);
}

/** Called by app.ts when the Session view is shown again. */
export function claimVoice(): void {
  if (currentId === undefined) return;
  setVoiceTarget(currentId);
}

/** Reflects both where speech will land and whether it is being captured
 *  right now — the indicator is the only thing telling the user which
 *  agent is about to be spoken to. */
export function renderVoiceTarget(active: boolean, listening: boolean): void {
  const badge = $("session-voice");
  if (badge === null) return;
  badge.hidden = !active;
  badge.classList.toggle("session-voice--listening", listening);
  badge.textContent = listening
    ? MESSAGES.voiceListeningHere(PRIMARY_LANGUAGE)
    : MESSAGES.voiceGoesHere(PRIMARY_LANGUAGE);
}

function ensureTerminal(): Terminal | undefined {
  if (terminal !== undefined) return terminal;
  const host = $("session-terminal");
  if (host === null) return undefined;

  const term = new Terminal({
    scrollback: SCROLLBACK_LINES,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.35,
    theme: THEME,
    cursorBlink: true,
    // The agent owns the window title and the bell; neither has anywhere
    // sensible to go inside a panel, so both are left alone.
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(host);

  // Every keystroke, verbatim — control bytes included, which is what makes
  // Ctrl-C, arrow keys, Escape and shift+tab work rather than only plain
  // text. `onData` already gives the encoded sequence the pty expects.
  term.onData((data) => {
    if (currentId === undefined) return;
    void window.jarvis.sendSessionInput(currentId, data);
  });

  // The pty's size must track the pane's, or the agent draws its UI to a
  // width that does not exist and the result is visibly mangled.
  term.onResize(({ cols, rows }) => {
    if (currentId === undefined) return;
    void window.jarvis.resizeSession(currentId, cols, rows);
  });

  terminal = term;
  fit = fitAddon;
  attached = true;
  observeSize(host);
  return term;
}

/** Re-fits on any change to the pane's box — window resize, view switch,
 *  or the header wrapping to a second line. */
function observeSize(host: HTMLElement): void {
  if (typeof ResizeObserver === "undefined") return;
  new ResizeObserver(() => refit()).observe(host);
}

function refit(): void {
  if (!attached || fit === undefined) return;
  // A pane with no layout yet (the view is hidden, or the window is
  // minimised) measures as zero and would make the addon throw.
  const host = $("session-terminal");
  if (host === null || host.clientWidth === 0 || host.clientHeight === 0) return;
  try {
    fit.fit();
  } catch {
    // A fit racing a layout change is not worth surfacing; the next
    // observation will correct it.
  }
}

/**
 * Opens one session's terminal. The backlog is written first so a session
 * opened partway through a run shows what it already drew; every later
 * chunk arrives through appendSessionOutput. Switching sessions clears the
 * screen rather than interleaving two agents' output.
 */
export async function openSession(session: Session): Promise<void> {
  currentId = session.id;
  renderHeader(session);
  showView("session");
  setVoiceTarget(session.id);

  const term = ensureTerminal();
  term?.reset();
  // The view was hidden until showView above, so the pane only has a real
  // size now — fit before writing so the backlog is laid out at the width
  // it will be read at.
  refit();

  let backlog = "";
  try {
    backlog = await window.jarvis.getSessionLog(session.id);
  } catch (error) {
    // A failed backlog read must not leave a dead terminal: the live
    // stream still works, so say what is missing and carry on.
    console.error(`Failed to load session output: ${errorMessage(error)}`);
  }

  // Guard against a slower open resolving after the user clicked a
  // different session — without this its backlog would land in the other
  // session's terminal.
  if (currentId !== session.id) return;

  if (backlog !== "") term?.write(backlog);
  term?.focus();
}

/** One chunk from the "session:output" channel. Ignored unless it belongs
 *  to the session on screen — the channel carries every session's output,
 *  since the main process has no idea which one is open. */
export function appendSessionOutput(output: SessionOutput): void {
  if (output.sessionId !== currentId) return;
  terminal?.write(output.chunk);
}

/** Keeps the header's state honest as the session progresses, and is how a
 *  session that exits while its terminal is open stops claiming to run. */
export function updateSessionHeader(sessions: Session[]): void {
  if (currentId === undefined) return;
  const session = sessions.find((candidate) => candidate.id === currentId);
  if (session === undefined) return;
  renderHeader(session);
}

export function wireSessionView(): void {
  $("nav-session")?.addEventListener("click", () => {
    // Reopens whatever is already loaded. With nothing loaded it still
    // switches views — the empty state explains itself, which beats a
    // button that appears to do nothing.
    showView("session");
    claimVoice();
    refit();
    terminal?.focus();
  });

  // Clicking anywhere in the pane focuses the terminal, so typing goes to
  // the agent without hunting for a cursor.
  $("session-terminal")?.addEventListener("click", () => terminal?.focus());

  window.addEventListener("resize", () => refit());
}

function renderHeader(session: Session): void {
  setText($("session-view-project"), session.project);
  setText($("session-view-path"), session.projectPath);
  const state = $("session-view-state");
  if (state !== null) state.textContent = session.state;
  const agent = $("session-view-agent");
  if (agent !== null) {
    agent.textContent = [session.agentId, session.model].filter(Boolean).join(" · ");
  }
  const empty = $("session-empty");
  if (empty !== null) empty.hidden = true;
}

/** Sets text and direction together — an Arabic project name must not be
 *  laid out left-to-right. Same rule as changes.ts's own setText. */
function setText(element: HTMLElement | null, text: string): void {
  if (element === null) return;
  const language = detectLanguage(text);
  element.dir = language === "ar" ? "rtl" : "ltr";
  element.classList.toggle("arabic", language === "ar");
  element.textContent = text;
}

/** Shown before any session has been opened, so the view is never a blank
 *  black rectangle with no explanation. */
export function renderEmptyState(): void {
  const empty = $("session-empty");
  if (empty === null) return;
  empty.textContent = MESSAGES.sessionNone(PRIMARY_LANGUAGE);
  empty.hidden = currentId !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
