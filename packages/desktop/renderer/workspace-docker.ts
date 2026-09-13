import type { DockerRow, DockerView, GitViewResult } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { Terminal } from "./vendor/xterm.mjs";

// The Workspace's Docker pane: one row per container the project declares
// in jarvis.yaml, paired with what Docker currently reports of it (or
// nothing, for a row that is configured but does not exist). Compose
// controls appear only when every row shares one compose project — the
// only case in which "up" and "down" have an unambiguous target (see
// DockerView.composeProject in src/ipc.ts).
//
// renderDockerPane is a pure function of (host, tabId, project, view): it
// never reads window.jarvis itself except from a click handler, which is
// what lets it be exercised in jsdom without any IPC standing behind it.
// attachDockerPane/detachDockerPane own the only state that must outlive a
// single render — the 3s poll and the log follower's terminal.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

/** Matches session-view's and the Workspace terminal's palette — a log is
 *  the same kind of surface in the user's eyes and must not look different. */
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

const LOG_TAIL_LINES = 500;
const POLL_INTERVAL_MS = 3_000;

type Pane = {
  logHost: HTMLElement;
  /** The left column of the spec's layout: the compose bar above the rows
   *  list, with the log beside it rather than beneath. Created once and
   *  kept, so the log is never detached by a re-render. */
  side: HTMLElement;
  /** The rows list, created once and refilled in place on every poll tick —
   *  see renderDockerPane. */
  rowsHost: HTMLElement;
  /** The "N of M running" line under the heading, refilled per tick. */
  count: HTMLElement;
  /** The "no container selected" placeholder standing in for the terminal,
   *  until the first row selection builds one. Removed then, and never
   *  rebuilt: a pane that has shown a log has nothing to say this for. */
  empty: HTMLElement | undefined;
  /** The compose bar, when the view has one. Removed and rebuilt as the
   *  view's compose project appears or goes away; `undefined` when the pane
   *  currently shows none. */
  compose: HTMLElement | undefined;
  /** Built lazily, on the first row selection: constructing an xterm
   *  instance touches real browser APIs (matchMedia, canvas) that plain DOM
   *  rendering has no reason to need, so a pane that is never selected
   *  never builds one. */
  terminal: Terminal | undefined;
  /** The terminal's fit addon and the observer that drives it — both live
   *  exactly as long as `terminal` does, and the observer must be
   *  disconnected when the pane is disposed or it outlives the element it
   *  watches, the same discipline workspace-terminal.ts follows. */
  fit: FitAddon | undefined;
  observer: ResizeObserver | undefined;
  /** The container currently selected for its log tail, if any. Survives a
   *  re-render (the 3s poll) so the highlighted row and the running
   *  follower do not reset every tick. */
  selected: string | undefined;
};

const panes = new Map<string, Pane>();

function getPane(tabId: string): Pane {
  const existing = panes.get(tabId);
  if (existing !== undefined) return existing;

  const logHost = document.createElement("div");
  logHost.className = "workspace-docker-log";
  const rowsHost = document.createElement("div");
  rowsHost.className = "workspace-docker-rows";
  // The heading is static chrome; only its count line changes per tick, so
  // it is built once here and the count refilled in renderDockerPane.
  const count = document.createElement("div");
  count.className = "workspace-docker-count";
  const heading = document.createElement("div");
  heading.className = "workspace-docker-heading";
  const title = document.createElement("div");
  title.className = "workspace-docker-title";
  title.textContent = MESSAGES.dockerHeading(PRIMARY_LANGUAGE);
  heading.append(title, count);

  // Sits where the terminal will go, and is removed by the first row
  // selection — the terminal itself is built lazily at that same moment.
  const empty = document.createElement("div");
  empty.className = "workspace-docker-empty";
  empty.textContent = MESSAGES.dockerNoSelection(PRIMARY_LANGUAGE);
  logHost.append(empty);

  const side = document.createElement("div");
  side.className = "workspace-docker-side";
  side.append(heading, rowsHost);
  const pane: Pane = {
    logHost,
    side,
    rowsHost,
    count,
    empty,
    compose: undefined,
    terminal: undefined,
    fit: undefined,
    observer: undefined,
    selected: undefined,
  };
  panes.set(tabId, pane);
  return pane;
}

/** Built the way workspace-terminal.ts:129 builds its terminal — same font,
 *  size, line height and theme, same fit addon and resize observer — but
 *  read-only: no terminal.onData wiring, because there is nothing to type
 *  into a log. Without the addon the log would render at xterm's default
 *  80×24 inside a pane that grows with the window, and would never reflow. */
function ensureTerminal(pane: Pane): Terminal {
  if (pane.terminal !== undefined) return pane.terminal;
  // The placeholder and the terminal are the same slot: whichever the pane
  // is showing, it is showing exactly one.
  pane.empty?.remove();
  pane.empty = undefined;
  const terminal = new Terminal({
    scrollback: LOG_TAIL_LINES,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.35,
    theme: THEME,
    disableStdin: true,
    cursorBlink: false,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(pane.logHost);
  pane.terminal = terminal;
  pane.fit = fit;
  refit(pane);

  if (typeof ResizeObserver !== "undefined") {
    pane.observer = new ResizeObserver(() => refit(pane));
    pane.observer.observe(pane.logHost);
  }
  return terminal;
}

/** The same guard workspace-terminal.ts's refit uses: a host with no layout
 *  yet (hidden, or the window minimised) measures as zero and would make the
 *  addon throw. */
function refit(pane: Pane): void {
  if (pane.fit === undefined) return;
  if (pane.logHost.clientWidth === 0 || pane.logHost.clientHeight === 0) return;
  try {
    pane.fit.fit();
  } catch {
    // A measurement the addon could not use. The log is still readable at
    // whatever size it currently has.
  }
}

function selectRow(host: HTMLElement, tabId: string, project: string, row: DockerRow): void {
  const pane = getPane(tabId);
  pane.selected = row.container;
  // The main process already unfollows whatever this tab was following
  // before — a second dockerFollow call replaces the first, it does not
  // stack with it.
  ensureTerminal(pane).clear();
  void window.jarvis.dockerFollow(tabId, project, row.container);

  for (const element of host.querySelectorAll(".workspace-docker-row")) {
    element.classList.toggle(
      "workspace-docker-row--selected",
      (element as HTMLElement).dataset["container"] === row.container,
    );
  }
}

function renderRow(host: HTMLElement, tabId: string, project: string, row: DockerRow): HTMLElement {
  const element = document.createElement("div");
  element.className = "workspace-docker-row";
  element.classList.toggle("workspace-docker-row--missing", row.facts === undefined);
  const pane = panes.get(tabId);
  element.classList.toggle("workspace-docker-row--selected", pane?.selected === row.container);
  element.dataset["container"] = row.container;

  // The state at a glance, off the same `.dot` vocabulary the session rows
  // use. "missing" is its own state rather than a shade of stopped: the
  // container is declared in `docker:` and Docker has never heard of it,
  // which is a configuration problem, not a lifecycle one.
  const dot = document.createElement("span");
  dot.className = `dot ${dotStateClass(row)}`;
  element.append(dot);

  const name = document.createElement("span");
  name.className = "workspace-docker-row-name";
  name.textContent = row.name;
  element.append(name);

  // Docker's own status vocabulary ("Up 3 hours", "Exited (0) 2 minutes
  // ago"), shown unchanged rather than translated — the same treatment
  // row.facts.status gets everywhere else. A missing container has none;
  // the dashed, muted --missing class is what marks the row, not a message
  // invented for the gap.
  const status = document.createElement("span");
  status.className = "workspace-docker-row-status";
  status.textContent = row.facts?.status ?? "";
  element.append(status);

  // The published ports, in Docker's own spelling, under the status — the
  // spec's `:8000→8000` line. A container that publishes nothing gets no
  // element at all rather than an empty one taking up a column.
  const ports = row.facts?.ports ?? [];
  if (ports.length > 0) {
    const published = document.createElement("span");
    published.className = "workspace-docker-row-ports";
    published.textContent = ports.join("  ");
    element.append(published);
  }

  element.addEventListener("click", () => selectRow(host, tabId, project, row));

  const running = row.facts !== undefined && row.facts.state === "running";
  const buttons = document.createElement("span");
  buttons.className = "workspace-docker-row-actions";

  if (running) {
    buttons.append(
      actionButton("■", MESSAGES.dockerActionStop(PRIMARY_LANGUAGE), () => {
        if (!window.confirm(MESSAGES.dockerConfirmStop(row.name, PRIMARY_LANGUAGE))) return;
        runAction(window.jarvis.dockerStop(project, row.container));
      }),
      actionButton("↻", MESSAGES.dockerActionRestart(PRIMARY_LANGUAGE), () => {
        if (!window.confirm(MESSAGES.dockerConfirmRestart(row.name, PRIMARY_LANGUAGE))) return;
        runAction(window.jarvis.dockerRestart(project, row.container));
      }),
    );
  } else {
    buttons.append(
      actionButton("▶", MESSAGES.dockerActionStart(PRIMARY_LANGUAGE), () => {
        runAction(window.jarvis.dockerStart(project, row.container));
      }),
    );
  }
  buttons.append(
    actionButton("❯", MESSAGES.dockerActionShell(PRIMARY_LANGUAGE), () => {
      runAction(window.jarvis.dockerShell(project, row.container));
    }),
  );
  // A click on a button is not a row selection.
  buttons.addEventListener("click", (event) => event.stopPropagation());
  element.append(buttons);

  return element;
}

/** Runs a Start/Stop/Restart/Shell/Compose action and routes a failure into
 *  the shared status line — the same surface, and the same clear-then-report
 *  shape, `openApi`/`openDocker` in workspace.ts use for their own failures.
 *  A dead container, a permission error, a compose file gone bad: none of
 *  these are visible any other way, since the next poll would otherwise be
 *  the only sign anything happened at all. */
function runAction(action: Promise<GitViewResult<void>>): void {
  const status = $("workspace-tool-status");
  status.textContent = "";
  status.classList.remove("workspace-tool-status--error");
  void action.then((result) => {
    if (result.ok) return;
    status.textContent = result.text;
    status.classList.add("workspace-tool-status--error");
  });
}

/** Which `.dot` modifier a row wears. Docker's six states collapse to the
 *  three a reader actually acts on: it is up, it is not, or it is coming and
 *  going and worth watching. */
function dotStateClass(row: DockerRow): string {
  if (row.facts === undefined) return "dot--missing";
  switch (row.facts.state) {
    case "running":
      return "dot--running";
    case "restarting":
    case "paused":
      return "dot--busy";
    default:
      return "dot--stopped";
  }
}

/** The compose bar's own button: a plain worded control, the one place in
 *  this pane where the label is the button. */
function composeButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/** A glyph button. The glyph is decoration — `aria-hidden` keeps a screen
 *  reader from reading "black square" — and the accessible name comes from
 *  the bilingual label on both `title` and `aria-label`. */
function actionButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-docker-action";
  button.title = label;
  button.setAttribute("aria-label", label);
  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = glyph;
  button.append(mark);
  button.addEventListener("click", onClick);
  return button;
}

function renderCompose(project: string, composeProject: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "workspace-docker-compose";

  const label = document.createElement("span");
  label.className = "workspace-docker-compose-label";
  label.textContent = composeProject;
  element.append(label);

  // Words, not glyphs, unlike the row actions: these act on the whole stack
  // and Down removes containers, so the bar says plainly what it does rather
  // than asking the reader to recognise a symbol.
  element.append(
    composeButton("Up", () => {
      runAction(window.jarvis.dockerComposeUp(project));
    }),
    composeButton("Down", () => {
      if (!window.confirm(MESSAGES.dockerConfirmComposeDown(composeProject, PRIMARY_LANGUAGE)))
        return;
      runAction(window.jarvis.dockerComposeDown(project));
    }),
  );

  return element;
}

/** Renders a DockerView into `host`. Pure DOM given the view — the pane's
 *  only state that must outlive this call (the selected row, its log
 *  terminal) lives in `panes`, keyed by tabId.
 *
 *  Only what the 3s poll can actually change is rebuilt: the rows, and the
 *  compose bar. `logHost` is attached once and left alone, because taking it
 *  out of the document every three seconds would drop whatever text the user
 *  had selected in the log and disturb xterm's own renderer under it. */
export function renderDockerPane(
  host: HTMLElement,
  tabId: string,
  project: string,
  view: DockerView,
): void {
  const pane = getPane(tabId);

  // Dropped before anything else is decided. The bar only exists while every
  // row shares one stack, which a poll can change either way — and because
  // the side column survives a re-render into a fresh host, clearing the
  // reference without removing the element would strand the old bar inside
  // it and grow a new one on every tick.
  pane.compose?.remove();
  pane.compose = undefined;

  // First render into this host, or a re-render after the failure branch
  // replaced the host's children with an error line.
  if (pane.side.parentElement !== host) {
    host.replaceChildren(pane.side, pane.logHost);
  }

  pane.rowsHost.replaceChildren(...view.rows.map((row) => renderRow(host, tabId, project, row)));

  const running = view.rows.filter((row) => row.facts?.state === "running").length;
  pane.count.textContent = MESSAGES.dockerRunningCount(running, view.rows.length, PRIMARY_LANGUAGE);

  // The compose bar sits above the rows, in the left column.
  if (view.composeProject !== undefined) {
    pane.compose = renderCompose(project, view.composeProject);
    pane.side.insertBefore(pane.compose, pane.rowsHost);
  }
}

type Attached = { timer: ReturnType<typeof setInterval> };
const attached = new Map<string, Attached>();

let logSubscribed = false;

/** `docker logs` is spawned on a pipe, not a pty, so its lines end in a bare
 *  LF. A terminal needs the CR too: without it every line starts at the
 *  column the previous one ended on and the pane renders a staircase. The
 *  Terminal tab never needed this because node-pty's cooked mode emits CRLF
 *  itself. A CR already present is left alone, so a chunk boundary that
 *  splits a CRLF cannot produce a doubled newline. */
export function toTerminalText(chunk: string): string {
  return chunk.replace(/\r?\n/g, "\r\n");
}

/** Wired once, ever — every pane created afterwards reads from this same
 *  subscription rather than adding one of its own, the same pattern
 *  workspace-terminal.ts's initWorkspaceTerminals uses for onTerminalData. */
function ensureLogSubscription(): void {
  if (logSubscribed) return;
  logSubscribed = true;
  window.jarvis.onDockerLog(({ tabId, chunk }) => {
    panes.get(tabId)?.terminal?.write(toTerminalText(chunk));
  });
}

/** Starts the docker tab's 3s poll and the log follower. A failed
 *  `dockerView` — the daemon is down, or not installed — renders its text
 *  into the pane and stops polling: asking the same question every three
 *  seconds will not bring a dead daemon up. */
export function attachDockerPane(tabId: string, project: string): void {
  ensureLogSubscription();

  async function poll(): Promise<void> {
    const result = await window.jarvis.dockerView(project);
    // detachDockerPane may have run while that request was in flight (the
    // tab closed, or the user switched away) — its answer must not paint a
    // pane nobody is looking at any more.
    if (!attached.has(tabId)) return;

    const host = $("workspace-docker");
    if (!result.ok) {
      host.replaceChildren();
      host.textContent = result.text;
      const entry = attached.get(tabId);
      if (entry !== undefined) clearInterval(entry.timer);
      return;
    }
    renderDockerPane(host, tabId, project, result.value);
  }

  void poll();
  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  attached.set(tabId, { timer });
}

/** Stops the poll and unfollows whatever log this tab was tailing, then
 *  disposes the pane entirely — terminal, resize observer and all.
 *
 *  Unlike workspace-terminal.ts's panes, which survive a tab switch, this
 *  runs on *hide* as well as on close (workspace.ts calls it whenever the
 *  Docker tab stops being the active one). So switching away and back loses
 *  the log's scrollback and the selected row: the log is re-tailed from
 *  Docker's own last 500 lines when the tab comes back, and a `docker logs
 *  -f` child is not left running for a pane nobody is looking at. That is
 *  the trade this makes deliberately. */
export function detachDockerPane(tabId: string): void {
  const entry = attached.get(tabId);
  if (entry !== undefined) clearInterval(entry.timer);
  attached.delete(tabId);
  void window.jarvis.dockerUnfollow(tabId);

  const pane = panes.get(tabId);
  pane?.observer?.disconnect();
  pane?.terminal?.dispose();
  panes.delete(tabId);
}
