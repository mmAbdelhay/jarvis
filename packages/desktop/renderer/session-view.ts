import type { Session, SessionOutput } from "@jarvis/core";
import type { TranscriptEntry } from "@jarvis/platform";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { currentView, showView } from "./views.js";
import {
  detectLanguage,
  dominantLanguage,
  formatAgo,
  formatEndedAt,
  projectLabel,
} from "./format.js";
import {
  NO_PROJECT,
  agentOptions,
  filterSessions,
  sortSessions,
  type SessionSortColumn,
  type SortDirection,
} from "./session-filter.js";
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
/**
 * The session whose backlog fetch has actually settled — never ahead of
 * `currentId`, which flips the instant `openSession` is called and long
 * before its `getSessionLog` await returns.
 *
 * `appendSessionOutput` drops a push unless both agree, for the same
 * reason terminal-pane.ts's own write-gate drops a live `terminal:data`
 * push before attach settles: Electron only delivers `getSessionLog`'s
 * reply after main's handler — which reads the log synchronously — has
 * returned, and a session's own pty output arrives as a separate
 * macrotask. So any push received before this session's fetch resolved was
 * necessarily emitted before that read ran, and is already in the backlog;
 * only a push after that point is new. Keeping this as its own variable,
 * rather than a boolean, is what keeps a slower `openSession` call that
 * resolves after the user has switched away from marking the *new*
 * session's stale backlog as settled.
 */
let settledId: string | undefined;

/** How terminals behave. Read once for the module, exactly as
 *  workspace-terminal.ts reads it and for the same reason: a change to
 *  jarvis.yaml takes effect on restart anyway. Until it resolves — and if
 *  it never does — the pane is built with these, which are the terminal
 *  Jarvis drew before blocks existed. */
let terminalSettings = {
  blocks: false,
  inputEditor: false,
  notifyAfterSeconds: 0,
  home: "",
  // 0 is right as the "not answered yet" value: a pane reads anything that
  // is not a positive number as "keep the default".
  scrollback: 0,
};
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
 * Whether the pane's live terminal — as opposed to the session table or a
 * transcript — is the thing actually on screen right now.
 *
 * Set by `showTable()` (false: the table is up) and `showSurface()` (true
 * only for `"terminal"`, never `"transcript"`, which shows a recorded
 * conversation with no pty behind it). `reassertSessionSize()` reads this:
 * sending a phone-visible size to a laptop that is looking at the table or
 * a transcript would reflow a terminal nobody on the laptop can see, which
 * is exactly what ruling 11's "when the view is shown" does not mean.
 */
let terminalVisible = false;

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

/**
 * Re-sends the open session's current pty size, unconditionally (ruling
 * 11: last writer wins, both sides re-assert).
 *
 * fit() only calls back into resize() on a genuine change of the pane's
 * own cell grid, so a phone that resized the pty while this view was not
 * looking leaves the laptop believing its old size forever — refit() alone
 * would never notice, since nothing about *this* pane's box changed. This
 * sends the laptop's real cols/rows every time the view could plausibly be
 * shown, whether or not they changed.
 *
 * On a genuine box change, `refit()` above already made the pane's own
 * `resize` hook send this exact size through its own path; the explicit
 * send below then repeats it. That is harmless — `resizeSession` is
 * idempotent — and is what covers the "unchanged locally" case the hook
 * never fires for at all.
 */
export function reassertSessionSize(): void {
  refit();
  if (currentId === undefined) return;
  if (pane === undefined) return;
  if (currentView() !== "session") return;
  // The table and a transcript both leave `currentView()` at "session" —
  // only `terminalVisible` tells the two apart from a terminal actually on
  // screen.
  if (!terminalVisible) return;
  const { cols, rows } = pane.terminal;
  if (cols < 1 || rows < 1) return;
  void window.jarvis.resizeSession(currentId, cols, rows);
}

// Registered once, at module init, so a phone-driven resize is picked up
// even if the window regains focus while some other view is on screen —
// reassertSessionSize itself is what declines to send in that case.
//
// Keyed on `window` itself, rather than left as a bare addEventListener:
// the app only ever loads this module once, but session-view.test.ts
// re-imports it fresh (vi.resetModules) for every test while jsdom's
// `window` outlives all of them, so a plain addEventListener would leave
// one stale, closed-over listener behind per test. Swapping the listener
// on each module load keeps exactly one live — the current module's own —
// the same singleton the production app has.
type FocusHost = typeof window & { __reassertSessionSizeOnFocus__?: () => void };
const focusHost = window as FocusHost;
if (focusHost.__reassertSessionSizeOnFocus__ !== undefined) {
  window.removeEventListener("focus", focusHost.__reassertSessionSizeOnFocus__);
}
const handleWindowFocus = (): void => reassertSessionSize();
focusHost.__reassertSessionSizeOnFocus__ = handleWindowFocus;
window.addEventListener("focus", handleWindowFocus);

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

/**
 * Every recorded session as a table, and the Session view's default screen.
 *
 * The view used to be one session's terminal and nothing else, so a session
 * could only be reached through the History overlay. The table makes the
 * whole record — 95 sessions on the machine this was built for, of which 89
 * were started in a terminal Jarvis never ran — the thing Session actually
 * shows.
 */
export async function renderSessionTable(): Promise<void> {
  const table = $("session-table");
  const body = $("session-table-body");
  if (table === null || body === null) return;

  // Both in parallel, one await point: getHistory() is sessionStore's own
  // record (Jarvis's sessions plus whatever the transcript importer has
  // read, never a row process-scan.ts found — session-import.ts's own
  // discipline is that nothing there can prove a live process, so it is
  // never persisted); listSessions is the merged live list, of which only
  // the "external" rows are new here — its Jarvis half duplicates what
  // getHistory() already returned.
  const [history, live] = await Promise.allSettled([
    window.jarvis.getHistory(),
    window.jarvis.listSessions(),
  ]);

  if (history.status === "fulfilled") {
    loaded = history.value;
  } else {
    console.error(`Failed to load sessions: ${errorMessage(history.reason)}`);
    loaded = [];
  }

  if (live.status === "fulfilled") {
    loaded = [...loaded, ...live.value.filter((session) => session.origin === "external")];
  } else {
    console.error(`Failed to load external sessions: ${errorMessage(live.reason)}`);
  }

  showTable();
  fillFilterOptions();
  drawRows();
}

/** Every session the last load returned, before any filtering. The filters
 *  work on this rather than re-querying: 96 rows is nothing to scan in the
 *  renderer, and it keeps typing in the search box instant. */
let loaded: Session[] = [];
let sortColumn: SessionSortColumn = "lastActivityAt";
let sortDirection: SortDirection = "desc";

/** Registry agent ids (jarvis.yaml), independent of whether any of them has
 *  run a session yet — app.ts sets this from getSettings() at load and
 *  again after every Save, the same snapshot pattern prayer.ts's own
 *  setPrayerSnapshot uses. */
let knownAgents: string[] = [];
export function setKnownAgents(agents: string[]): void {
  knownAgents = agents;
}

/** The project filter offers what the table actually contains — a project
 *  with no sessions would be a dead end. The agent filter is different on
 *  purpose: it also offers every registry agent, even one with nothing
 *  behind it yet, so a freshly added agent is not a dead end until it has
 *  run something (see agentOptions). */
function fillFilterOptions(): void {
  const projectSelect = $("session-filter-project") as HTMLSelectElement | null;
  if (projectSelect !== null) {
    const chosen = projectSelect.value;
    const names = [...new Set(loaded.map((s) => s.project).filter((p): p is string => p !== null))];
    names.sort((a, b) => a.localeCompare(b));
    const options = [option("", "All projects"), ...names.map((n) => option(n, n))];
    if (loaded.some((s) => s.project === null)) options.push(option(NO_PROJECT, "No project"));
    projectSelect.replaceChildren(...options);
    projectSelect.value = chosen;
  }

  const agentSelect = $("session-filter-agent") as HTMLSelectElement | null;
  if (agentSelect !== null) {
    const chosen = agentSelect.value;
    agentSelect.replaceChildren(
      option("", "All agents"),
      ...agentOptions(loaded, knownAgents).map((id) => option(id, id)),
    );
    agentSelect.value = chosen;
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

/** Filter, sort, draw. Every control funnels through here so there is one
 *  description of what the table shows. */
function drawRows(): void {
  const table = $("session-table");
  const body = $("session-table-body");
  if (table === null || body === null) return;

  const shown = sortSessions(
    filterSessions(loaded, {
      query: ($("session-search") as HTMLInputElement | null)?.value ?? "",
      project: ($("session-filter-project") as HTMLSelectElement | null)?.value ?? "",
      agent: ($("session-filter-agent") as HTMLSelectElement | null)?.value ?? "",
    }),
    sortColumn,
    sortDirection,
  );

  const count = $("session-count");
  if (count !== null) {
    // "12 of 96" only while something is narrowing: a bare total is what the
    // reader wants when nothing is filtered, and the comparison is noise.
    count.textContent =
      shown.length === loaded.length
        ? `${loaded.length} sessions`
        : `${shown.length} of ${loaded.length}`;
  }

  markSortedColumn();
  table.querySelector(".session-table-empty")?.remove();
  if (shown.length === 0) {
    // An empty table is indistinguishable from a broken one, and the two
    // reasons for it are worth telling apart.
    const empty = document.createElement("div");
    empty.className = "session-table-empty";
    empty.textContent =
      loaded.length === 0 ? "No sessions recorded yet." : "No sessions match these filters.";
    body.replaceChildren();
    table.append(empty);
    return;
  }
  body.replaceChildren(...shown.map(buildSessionTableRow));
}

/** An arrow on the column being sorted, so the order is never a mystery. */
function markSortedColumn(): void {
  for (const th of document.querySelectorAll<HTMLElement>("#session-table th[data-sort]")) {
    const active = th.dataset["sort"] === sortColumn;
    th.classList.toggle("session-th--active", active);
    th.dataset["direction"] = active ? sortDirection : "";
  }
}

function buildSessionTableRow(session: Session): HTMLElement {
  const row = document.createElement("tr");
  row.className = "session-table-row";

  // The prompt is what a reader scans for, so it carries the row: full size
  // on its own line, with everything that merely locates the session — the
  // project, the directory it ran in, the branch — muted beneath it. Seven
  // columns of equal weight made the thing you are looking for the same size
  // as the word "done".
  const main = document.createElement("td");
  main.className = "session-cell-main";

  const summary = document.createElement("div");
  summary.className = "session-summary";
  const text = session.summary === "" ? "No prompt recorded" : session.summary;
  const language = detectLanguage(text);
  summary.dir = language === "ar" ? "rtl" : "ltr";
  summary.classList.toggle("arabic", language === "ar");
  summary.classList.toggle("session-summary--empty", session.summary === "");
  summary.textContent = text;

  const meta = document.createElement("div");
  meta.className = "session-meta mono";
  const label = document.createElement("span");
  label.className = "session-chip";
  label.textContent = projectLabel(session);
  meta.append(label, detail(session.projectPath));
  if (session.branch !== undefined && session.branch !== "") meta.append(detail(session.branch));

  main.append(summary, meta);

  const agent = document.createElement("td");
  agent.className = "session-cell-agent mono";
  const agentChip = document.createElement("span");
  agentChip.className = "session-chip";
  agentChip.textContent = session.agentId;
  // The model on hover rather than on a second wrapped line: it matters when
  // you ask for it and is noise on all 96 rows at once.
  if (session.model !== undefined) agentChip.title = session.model;
  agent.append(agentChip);

  const state = document.createElement("td");
  state.className = "session-cell-state mono";
  // The dot and its word live in a span, not in the cell: `display: flex` on
  // a <td> takes it out of table layout, which loses the row's shared height
  // and leaves its bottom border drawn at a different place from its
  // neighbours'.
  const stateBox = document.createElement("span");
  stateBox.className = "session-state";
  const dot = document.createElement("span");
  dot.className = `session-dot session-dot--${session.state}`;
  const stateText = document.createElement("span");
  stateText.textContent = session.state;
  stateBox.append(dot, stateText);
  state.append(stateBox);

  const when = document.createElement("td");
  when.className = "session-cell-when mono";
  when.textContent = formatAgo(session.lastActivityAt, Date.now());
  // The exact moment is one hover away; "4m ago" is what the row is read for.
  when.title = formatEndedAt(session.lastActivityAt);

  // A row process-scan.ts found running outside Jarvis: read-only, so it
  // gets a chip in place of the state Jarvis cannot actually observe for
  // it, and no Resume button — there is no transcript id Jarvis minted to
  // resume, and the process is already running.
  const external = session.origin === "external";
  if (external) {
    const chip = document.createElement("span");
    chip.className = "session-chip session-chip--external";
    chip.textContent = MESSAGES.sessionOutsideJarvis(PRIMARY_LANGUAGE);
    meta.append(chip);
  }

  const actions = document.createElement("td");
  actions.className = "session-cell-actions";
  if (!external) {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "session-table-resume";
    resume.textContent = "Resume";
    resume.addEventListener("click", (event) => {
      // The row opens the transcript; the button continues the session.
      // Both are useful and they must not fire together.
      event.stopPropagation();
      void resumeInTerminal(session.id);
    });
    actions.append(resume);
  }

  row.append(main, agent, state, when, actions);
  row.addEventListener("click", () => void openSession(session));
  return row;
}

/** One muted fragment of a row's second line. */
function detail(text: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "session-detail-part";
  element.textContent = text;
  return element;
}

/**
 * Continues a session in a Workspace Terminal tab.
 *
 * The selected project is passed because a session whose directory is not
 * any configured project's still needs a project to hang its tab on — the
 * Workspace has no way to display one that belongs to none.
 */
async function resumeInTerminal(id: string): Promise<void> {
  const selected = (document.getElementById("workspace-project") as HTMLSelectElement | null)
    ?.value;
  let result: { ok: boolean; text?: string; project?: string };
  try {
    result = await window.jarvis.resumeSession(id, selected ?? "");
  } catch (error) {
    result = { ok: false, text: errorMessage(error) };
  }
  const status = $("session-table-status");
  if (!result.ok) {
    // A button that silently does nothing is the bug this view exists to fix.
    if (status !== null) status.textContent = result.text ?? "";
    return;
  }
  if (status !== null) status.textContent = "";
  // The tab is already open in the main process; the view follows it.
  const select = document.getElementById("workspace-project") as HTMLSelectElement | null;
  if (select !== null && result.project !== undefined && select.value !== result.project) {
    select.value = result.project;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  document.getElementById("nav-workspace")?.click();
}

/** The table showing, the terminal put away. */
function showTable(): void {
  const table = $("session-table");
  if (table !== null) table.hidden = false;
  // The header's project chip, path, state and agent describe one open
  // session. Left on over the table they render as an empty chip and a
  // stray rule beside the title, describing nothing.
  setDetailVisible(false);
  const back = $("session-back");
  if (back !== null) back.hidden = true;
  const empty = $("session-empty");
  if (empty !== null) empty.hidden = true;
  // Whatever session was open, its terminal is no longer what is on
  // screen — see `terminalVisible`'s own comment.
  terminalVisible = false;
  showView("session");
}

function setDetailVisible(visible: boolean): void {
  const detail = $("session-detail");
  if (detail !== null) detail.hidden = !visible;
  for (const id of ["session-view-project", "session-view-path"]) {
    const element = $(id);
    if (element !== null) element.hidden = !visible;
  }
}

/** The terminal showing, the table put away. */
function showTerminal(): void {
  const table = $("session-table");
  if (table !== null) table.hidden = true;
  setDetailVisible(true);
  const back = $("session-back");
  if (back !== null) {
    back.hidden = false;
    back.onclick = () => void renderSessionTable();
  }
}

export async function openSession(session: Session): Promise<void> {
  currentId = session.id;
  // Reopening the same id must close the gate again: settledId otherwise
  // still equals this session's id from the last time it was open, so a
  // push arriving during this fresh getSessionLog await would pass the
  // gate and land both live and in the backlog about to be written.
  settledId = undefined;
  // The *configured* project, not the display label: this drives
  // openTab(), and there is no workspace to open for a directory that is
  // not a project.
  currentProject = session.project ?? undefined;
  renderHeader(session);
  showView("session");

  // A row outside Jarvis has no pty and nothing Jarvis can type into — only
  // a transcript, when the scan matched one, or a plain notice when it did
  // not. No pane, no voice target: there is no input affordance to give.
  if (session.origin === "external") {
    await openExternalSession(session);
    return;
  }

  showTerminal();
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
  // The fetch above has settled for this exact session: from here on a
  // live push for it is new, not a duplicate of what was just read — see
  // `settledId`'s own comment for why that ordering holds.
  settledId = session.id;

  // A session Jarvis spawned replays its pty backlog into the emulator —
  // that output really is a terminal's. One started in a terminal has no pty
  // and no backlog, only a recorded conversation, and a conversation laid
  // out in xterm is monospace with no way to tell whose words are whose. So
  // the two take different surfaces, and only one is ever on screen.
  if (backlog === "") {
    let entries: TranscriptEntry[] = [];
    try {
      entries = await window.jarvis.getSessionTranscript(session.id);
    } catch (error) {
      console.error(`Failed to load session transcript: ${errorMessage(error)}`);
    }
    if (currentId !== session.id) return;
    if (entries.length > 0) {
      renderTranscriptView(entries);
      return;
    }
  }

  showSurface("terminal");
  // Through the pane rather than straight to xterm: the backlog can carry
  // the same integration marks the live stream does, and a block whose
  // command finished before the view was opened is still a block.
  if (backlog !== "") view?.write(backlog);
  view?.focus();
  // The backlog write has settled: tell the pty this session's real size,
  // even if it matches what the pane already had (ruling 11) — a phone may
  // have resized it while nothing on the laptop was open to notice.
  reassertSessionSize();
}

/**
 * A row process-scan.ts found running outside Jarvis. It has no pty
 * backlog to read — getSessionLog would only ever answer "" for one — so
 * this goes straight for whatever transcript the scan matched, and shows a
 * notice when it found none rather than a blank live-looking terminal
 * nothing is actually attached to.
 */
async function openExternalSession(session: Session): Promise<void> {
  setDetailVisible(true);
  const back = $("session-back");
  if (back !== null) {
    back.hidden = false;
    back.onclick = () => void renderSessionTable();
  }
  // No pty behind this row at all — see `terminalVisible`'s own comment.
  terminalVisible = false;

  let entries: TranscriptEntry[] = [];
  try {
    entries = await window.jarvis.getSessionTranscript(session.id);
  } catch (error) {
    console.error(`Failed to load session transcript: ${errorMessage(error)}`);
  }
  if (currentId !== session.id) return;
  if (entries.length > 0) {
    renderTranscriptView(entries);
    return;
  }

  const view = $("session-transcript");
  if (view === null) return;
  const notice = document.createElement("div");
  notice.className = "session-transcript-notice";
  notice.textContent = MESSAGES.sessionNoTranscript(PRIMARY_LANGUAGE);
  view.replaceChildren(notice);
  showSurface("transcript");
}

/** One chunk from the "session:output" channel. Ignored unless it belongs
 *  to the session on screen — the channel carries every session's output,
 *  since the main process has no idea which one is open. */
export function appendSessionOutput(output: SessionOutput): void {
  if (output.sessionId !== currentId) return;
  // Dropped until this session's own backlog fetch has settled — see
  // `settledId`'s comment for why a push before that point is redundant
  // with the backlog rather than lost.
  if (output.sessionId !== settledId) return;
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
    // The table, always — Session is the list of sessions, and a session's
    // terminal is what you get by picking one. Reopening whatever happened
    // to be loaded made the view depend on invisible state.
    //
    // reassertSessionSize() is chained onto the table's own render rather
    // than called alongside it: renderSessionTable() only shows the table
    // — and terminalVisible only turns false — after its `getHistory`
    // await settles. Calling it straight away would still see the
    // terminal that was open a moment ago and send its now-stale size,
    // describing a terminal that is about to be hidden.
    void renderSessionTable().then(() => reassertSessionSize());
    claimVoice();
  });

  $("session-search")?.addEventListener("input", () => drawRows());
  $("session-filter-project")?.addEventListener("change", () => drawRows());
  $("session-filter-agent")?.addEventListener("change", () => drawRows());

  for (const th of document.querySelectorAll<HTMLElement>("#session-table th[data-sort]")) {
    th.addEventListener("click", () => {
      const column = th.dataset["sort"] as SessionSortColumn | undefined;
      if (column === undefined) return;
      // Clicking the sorted column reverses it; clicking another takes it
      // over, starting from the direction that column is usually read in.
      if (column === sortColumn) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
      } else {
        sortColumn = column;
        sortDirection = column === "lastActivityAt" ? "desc" : "asc";
      }
      drawRows();
    });
  }

  // Clicking anywhere in the pane focuses the terminal, so typing goes to
  // the agent without hunting for a cursor.
  $("session-terminal")?.addEventListener("click", () => pane?.focus());

  window.addEventListener("resize", () => refit());

  // The table is pulled (getHistory + listSessions above), never pushed —
  // unlike the Dashboard SESSIONS card, which redraws on its own from the
  // "sessions:update" the scan already broadcasts, this one needs an
  // explicit re-render once the scan settles.
  wireSessionsRefresh($("session-refresh"), () => void renderSessionTable());
}

/**
 * Wires a Refresh button to sessions:refresh — the Sessions view header and
 * the Dashboard SESSIONS card header both use this, since both trigger the
 * exact same scan. Disabled and spinning for the duration of the call;
 * `afterRefresh` runs once it settles, for a caller (the Session table)
 * that is pulled rather than redrawn by the "sessions:update" push the scan
 * itself broadcasts. Takes the element rather than an id — the caller does
 * its own `$(id)` lookup, so id-contract.test.ts still sees the literal.
 */
export function wireSessionsRefresh(button: HTMLElement | null, afterRefresh?: () => void): void {
  if (button === null || !(button instanceof HTMLButtonElement)) return;
  button.setAttribute("aria-label", MESSAGES.refreshSessions(PRIMARY_LANGUAGE));
  button.addEventListener("click", () => {
    void runSessionsRefresh(button, afterRefresh);
  });
}

async function runSessionsRefresh(
  button: HTMLButtonElement,
  afterRefresh?: () => void,
): Promise<void> {
  button.disabled = true;
  button.classList.add("icon-btn--spinning");
  try {
    await window.jarvis.refreshSessions();
  } catch (error) {
    console.error(`Sessions refresh failed: ${errorMessage(error)}`);
  } finally {
    button.disabled = false;
    button.classList.remove("icon-btn--spinning");
  }
  afterRefresh?.();
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
  renderResume(session);
}

/**
 * The Resume button, offered only for a session that has ended.
 *
 * A session Jarvis is already running has a live process behind it, and
 * resuming that would put a second agent on the same conversation. A past
 * one — every session imported from a terminal is past, since the importer
 * never claims a state it cannot observe — is exactly what resume is for.
 */
function renderResume(session: Session): void {
  const button = $("session-resume");
  if (button === null) return;
  const ended = session.state === "done" || session.state === "dead";
  button.hidden = !ended;
  if (!ended) return;
  // The same path as the table's own Resume: one way to continue a
  // session, reachable from either screen.
  button.onclick = () => {
    void resumeInTerminal(session.id);
  };
}

/**
 * A recorded conversation, laid out as one.
 *
 * Every turn's words go in through textContent: a transcript is whatever
 * someone typed at an agent, so it is displayed and never interpreted. Tools
 * are named as chips beside the reply rather than printed inline, because
 * which tools ran is the shape of a turn while their arguments are not.
 */
function renderTranscriptView(entries: TranscriptEntry[]): void {
  const view = $("session-transcript");
  if (view === null) return;
  view.replaceChildren(...entries.map(buildTranscriptTurn));
  showSurface("transcript");
  view.scrollTop = 0;
}

function buildTranscriptTurn(entry: TranscriptEntry): HTMLElement {
  const turn = document.createElement("div");
  turn.className = `transcript-turn transcript-turn--${entry.role}`;

  if (entry.text !== "") {
    const body = document.createElement("div");
    body.className = "transcript-text";
    // Dominance, not presence: a turn is a paragraph, and an English reply
    // that quotes one Arabic string is English. Laying the whole block
    // right-to-left because of that quotation moved its full stops to the
    // front of every line.
    const language = dominantLanguage(entry.text);
    body.dir = language === "ar" ? "rtl" : "ltr";
    body.classList.toggle("arabic", language === "ar");
    body.textContent = entry.text;
    turn.append(body);
  }

  if (entry.tools.length > 0) {
    const tools = document.createElement("div");
    tools.className = "transcript-tools";
    for (const name of entry.tools) {
      const chip = document.createElement("span");
      chip.className = "transcript-tool";
      chip.textContent = name;
      tools.append(chip);
    }
    turn.append(tools);
  }
  return turn;
}

/** Exactly one of the session view's two surfaces is ever on screen. */
function showSurface(which: "terminal" | "transcript"): void {
  const terminalHost = $("session-terminal");
  if (terminalHost !== null) terminalHost.hidden = which !== "terminal";
  const transcript = $("session-transcript");
  if (transcript !== null) transcript.hidden = which !== "transcript";
  // A transcript has no pty behind it — see `terminalVisible`'s own comment.
  terminalVisible = which === "terminal";
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
