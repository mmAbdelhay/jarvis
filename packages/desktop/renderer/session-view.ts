import type { Session, SessionOutput } from "@jarvis/core";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { showView } from "./views.js";
import { detectLanguage, projectLabel } from "./format.js";
import { enhanceTerminal } from "./terminal-addons.js";
import { createPane, type TerminalPane } from "./terminal-pane.js";

// The Session view: one agent process's real terminal.
//
// The agent runs under a pty (see platform/src/pty.ts) and draws a full
// terminal UI, so this is a genuine terminal emulator rather than a log
// pane — every byte the agent writes goes to xterm.js untouched, and every
// keystroke goes back to the pty untouched. Nothing in here parses or
// rewrites the stream: an agent's own UI owns what the session looks like,
// which is the whole point of running it this way.
//
// The screen itself is a terminal pane (terminal-pane.ts), the same one the
// Workspace's Terminal tabs are built from, so the two surfaces are the same
// terminal down to the last keystroke. In practice a session looks almost
// exactly as it did before that move: an agent holds the alternate screen
// for nearly the whole of its run, and a pane suppresses its blocks — and
// its editor with them — for as long as anything does. What changes is that
// a session which *does* drop back to a shell prompt with the integration
// marks on it now gets the same blocks everything else does, rather than a
// second, lesser terminal.

const $ = (id: string): HTMLElement | null => document.getElementById(id);

let pane: TerminalPane | undefined;
let currentId: string | undefined;
/** The open session's project, for links clicked in its terminal. */
let currentProject: string | undefined;

/** How terminals behave. Read once for the module, exactly as
 *  workspace-terminal.ts reads it and for the same reason: a change to
 *  jarvis.yaml takes effect on restart anyway. Until it resolves — and if
 *  it never does — the pane is built with these, which are the terminal
 *  Jarvis drew before blocks existed. */
let terminalSettings = { blocks: false, inputEditor: false, notifyAfterSeconds: 0, home: "" };
try {
  void window.jarvis
    .terminalSettings()
    .then((settings) => {
      terminalSettings = settings;
    })
    .catch(() => {
      // Today's terminal. Nothing else about the session is affected.
    });
} catch {
  // A preload without the channel — the same fallback.
}

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

/** Bytes to whichever session is on screen. Nothing to send them to before
 *  one has been opened, which is the same guard the module has always had
 *  around every one of these channels. */
function sendInput(data: string): void {
  if (currentId === undefined) return;
  void window.jarvis.sendSessionInput(currentId, data);
}

function ensurePane(): TerminalPane | undefined {
  if (pane !== undefined) return pane;
  const host = $("session-terminal");
  if (host === null) return undefined;

  // The pane's terminal, on exactly the terms every other terminal gets it.
  // What differs is only where the bytes go: an agent's pty through
  // sendSessionInput/resizeSession, rather than a shell through the
  // terminal channels.
  const view = createPane(host, {
    // Every keystroke, verbatim — control bytes included, which is what
    // makes Ctrl-C, arrow keys, Escape and shift+tab work rather than only
    // plain text.
    sendInput,
    // The pty's size must track the pane's, or the agent draws its UI to a
    // width that does not exist and the result is visibly mangled.
    resize: (cols, rows) => {
      if (currentId === undefined) return;
      void window.jarvis.resizeSession(currentId, cols, rows);
    },
    // Nothing to replay: a session's backlog is per-session and belongs to
    // openSession, which reads it fresh (and races it against the user
    // clicking a different session) every time one is opened. The pane
    // outlives any one session, so it has no prologue of its own.
    attach: () => Promise.resolve(""),
    settings: terminalSettings,
    notify: (title, body) => {
      try {
        new Notification(title, { body });
      } catch {
        // Notification unsupported or denied: no less a working terminal.
      }
    },
    // What ⌘P's "Run workflow…" offers — the open session's project's saved
    // workflows. Guarded the same way workspace-terminal.ts guards it: a
    // channel that fails leaves the action with nothing to offer, never a
    // terminal that throws.
    workflows: async () => {
      if (currentProject === undefined) return [];
      try {
        return await window.jarvis.terminalWorkflows(currentProject);
      } catch {
        return [];
      }
    },
    // The two AI actions' route to the brain, unchanged from a Terminal tab.
    terminalAi: (kind, text) => window.jarvis.terminalAi(kind, text),
    // No `history`: Jarvis's command log is keyed by *shell*, and a session
    // is an agent's pty rather than a shell of Jarvis's. Absent means the
    // editor's arrows leave the line alone and ⌘P offers no history search
    // — the documented meaning of the hook being missing, not a special
    // case for this route.
    //
    // No `splitKeys` either: the Session view is one agent's terminal and
    // has no tree to split, so the palette leaves those three actions out
    // rather than offering an action that does nothing.
  });

  // Addons, key bindings and the find bar — shared with the Workspace's
  // terminal tabs so the two behave identically. After open(): WebGL needs a
  // real element to attach a context to.
  enhanceTerminal(view.terminal, view.element, {
    sendInput,
    // A link clicked in an agent's output opens as a Workspace browser tab in
    // that agent's own project, rather than being handed to the OS.
    openLink: (url) => {
      if (currentProject === undefined) return;
      void window.jarvis.openTab(currentProject, url);
    },
    // Undefined with blocks switched off, which leaves ⌘↑/⌘↓/⌘⇧F behaving
    // exactly as they do today rather than claiming a key and doing
    // nothing with it.
    blockNav: view.blockNav,
    openPalette: () => view.openPalette(),
  });

  pane = view;
  observeSize(host);
  return view;
}

/** Re-fits on any change to the pane's box — window resize, view switch,
 *  or the header wrapping to a second line. */
function observeSize(host: HTMLElement): void {
  if (typeof ResizeObserver === "undefined") return;
  new ResizeObserver(() => refit()).observe(host);
}

function refit(): void {
  // A pane with no layout yet (the view is hidden, or the window is
  // minimised) measures as zero, which the pane's own refit already
  // declines to fit at.
  pane?.refit();
}

/** Clears the live terminal's screen once everything already queued for its
 *  parser has been drawn — see the call site for why the ordering matters.
 *  Never throws: a terminal that will not take the write leaves the screen
 *  as it is, which is a great deal better than an exception in the middle of
 *  opening a session. */
function clearLiveScreen(view: TerminalPane | undefined): void {
  const terminal = view?.terminal;
  if (terminal === undefined) return;
  try {
    terminal.write("", () => {
      try {
        terminal.reset();
      } catch {
        // A pane disposed while this was queued. Nothing to clear.
      }
    });
  } catch {
    // Nothing written, nothing cleared.
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
  // The *configured* project, not the display label: this drives
  // openTab(), and there is no workspace to open for a directory that is
  // not a project.
  currentProject = session.project ?? undefined;
  renderHeader(session);
  showView("session");
  setVoiceTarget(session.id);

  const view = ensurePane();
  // A different agent's screen must not be drawn over the last one's — and
  // neither must its blocks. The pane outlives any one session (it is
  // pointed at whichever agent is open), so both halves of what it shows
  // are cleared here: the live terminal's screen, and the frozen blocks
  // above it. Today no agent produces blocks at all — an agent binary is
  // exec'd directly, with no shell stage to print the integration marks —
  // but nothing enforces that, and one agent's output under another's
  // terminal is not a failure worth leaving to an architectural accident.
  //
  // The screen is cleared *behind* the write buffer, never straight from
  // here. Terminal.write() always defers its parsing to a macrotask and
  // reset() neither drains nor discards what is queued, so a synchronous
  // reset clears the screen and then lets the previous agent's still-queued
  // bytes paint over it — the interleaving this whole block exists to
  // prevent, arriving by the back door. An empty write is the queue's own
  // "everything before this has been parsed" signal, and the backlog below
  // is written after it, so the parser takes the two in that order: clear,
  // then draw. (The same fix terminal-pane.ts's block-done path carries,
  // for the same reason.)
  clearLiveScreen(view);
  view?.reset();
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

  // Through the pane rather than straight to xterm: the backlog can carry
  // the same integration marks the live stream does, and a block whose
  // command finished before the view was opened is still a block.
  if (backlog !== "") view?.write(backlog);
  view?.focus();
}

/** One chunk from the "session:output" channel. Ignored unless it belongs
 *  to the session on screen — the channel carries every session's output,
 *  since the main process has no idea which one is open. */
export function appendSessionOutput(output: SessionOutput): void {
  if (output.sessionId !== currentId) return;
  pane?.write(output.chunk);
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
    pane?.focus();
  });

  // Clicking anywhere in the pane focuses the terminal, so typing goes to
  // the agent without hunting for a cursor.
  $("session-terminal")?.addEventListener("click", () => pane?.focus());

  window.addEventListener("resize", () => refit());
}

function renderHeader(session: Session): void {
  setText($("session-view-project"), projectLabel(session));
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
