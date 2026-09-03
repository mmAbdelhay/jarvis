import type { DockerRow, DockerView } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
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
  /** Built lazily, on the first row selection: constructing an xterm
   *  instance touches real browser APIs (matchMedia, canvas) that plain DOM
   *  rendering has no reason to need, so a pane that is never selected
   *  never builds one. */
  terminal: Terminal | undefined;
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
  const pane: Pane = { logHost, terminal: undefined, selected: undefined };
  panes.set(tabId, pane);
  return pane;
}

/** Built the way workspace-terminal.ts:129 builds its terminal — same font,
 *  size, line height and theme — but read-only: no terminal.onData wiring,
 *  because there is nothing to type into a log. */
function ensureTerminal(pane: Pane): Terminal {
  if (pane.terminal !== undefined) return pane.terminal;
  const terminal = new Terminal({
    scrollback: LOG_TAIL_LINES,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.35,
    theme: THEME,
    disableStdin: true,
    cursorBlink: false,
  });
  terminal.open(pane.logHost);
  pane.terminal = terminal;
  return terminal;
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

  const name = document.createElement("span");
  name.className = "workspace-docker-row-name";
  name.textContent = row.name;
  element.append(name);

  // Docker's own status vocabulary ("running", "exited (0) 2 minutes ago"),
  // shown unchanged rather than translated — the same treatment
  // row.facts.status gets everywhere else. A missing container has none;
  // the dashed, muted --missing class is what marks the row, not a message
  // invented for the gap.
  const status = document.createElement("span");
  status.className = "workspace-docker-row-status";
  status.textContent = row.facts?.status ?? "";
  element.append(status);

  element.addEventListener("click", () => selectRow(host, tabId, project, row));

  const running = row.facts !== undefined && row.facts.state === "running";
  const buttons = document.createElement("span");
  buttons.className = "workspace-docker-row-actions";

  if (running) {
    buttons.append(
      actionButton("Stop", () => {
        if (!window.confirm(MESSAGES.dockerConfirmStop(row.name, PRIMARY_LANGUAGE))) return;
        void window.jarvis.dockerStop(project, row.container);
      }),
      actionButton("Restart", () => {
        if (!window.confirm(MESSAGES.dockerConfirmRestart(row.name, PRIMARY_LANGUAGE))) return;
        void window.jarvis.dockerRestart(project, row.container);
      }),
    );
  } else {
    buttons.append(
      actionButton("Start", () => {
        void window.jarvis.dockerStart(project, row.container);
      }),
    );
  }
  buttons.append(
    actionButton("Shell", () => {
      void window.jarvis.dockerShell(project, row.container);
    }),
  );
  // A click on a button is not a row selection.
  buttons.addEventListener("click", (event) => event.stopPropagation());
  element.append(buttons);

  return element;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
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

  element.append(
    actionButton("Up", () => {
      void window.jarvis.dockerComposeUp(project);
    }),
    actionButton("Down", () => {
      if (!window.confirm(MESSAGES.dockerConfirmComposeDown(composeProject, PRIMARY_LANGUAGE))) return;
      void window.jarvis.dockerComposeDown(project);
    }),
  );

  return element;
}

/** Renders a DockerView into `host`. Pure DOM given the view — the pane's
 *  only state that must outlive this call (the selected row, its log
 *  terminal) lives in `panes`, keyed by tabId, and is merely re-attached
 *  here rather than rebuilt. */
export function renderDockerPane(host: HTMLElement, tabId: string, project: string, view: DockerView): void {
  host.replaceChildren();

  const rows = document.createElement("div");
  rows.className = "workspace-docker-rows";
  for (const row of view.rows) rows.append(renderRow(host, tabId, project, row));
  host.append(rows);

  if (view.composeProject !== undefined) {
    host.append(renderCompose(project, view.composeProject));
  }

  host.append(getPane(tabId).logHost);
}

type Attached = { timer: ReturnType<typeof setInterval> };
const attached = new Map<string, Attached>();

let logSubscribed = false;

/** Wired once, ever — every pane created afterwards reads from this same
 *  subscription rather than adding one of its own, the same pattern
 *  workspace-terminal.ts's initWorkspaceTerminals uses for onTerminalData. */
function ensureLogSubscription(): void {
  if (logSubscribed) return;
  logSubscribed = true;
  window.jarvis.onDockerLog(({ tabId, chunk }) => {
    panes.get(tabId)?.terminal?.write(chunk);
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

/** Stops the poll and unfollows whatever log this tab was tailing. The
 *  pane's terminal is disposed with it — closing the tab is the only way to
 *  lose its scrollback, same as workspace-terminal.ts's terminals. */
export function detachDockerPane(tabId: string): void {
  const entry = attached.get(tabId);
  if (entry !== undefined) clearInterval(entry.timer);
  attached.delete(tabId);
  void window.jarvis.dockerUnfollow(tabId);

  panes.get(tabId)?.terminal?.dispose();
  panes.delete(tabId);
}
