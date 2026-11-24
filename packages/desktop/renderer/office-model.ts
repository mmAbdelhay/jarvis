// The Office's model: which employees sit in which room, what each one is
// doing, and where everything goes. Pure — no DOM, no clock of its own (`now`
// comes in), nothing logged — so every rule here is testable with plain data.
//
// One employee per tab. A Terminal tab's split panes are one employee, and a
// question in any of them raises its hand. An agent's session row inside a
// pane merges into that tab's employee; a live agent with no tab gets its
// own. Tabs and agents with no project sit in the Lounge.

import type { Session, WorkspaceState, WorkspaceTab } from "@jarvis/core";
import type { OfficeActivity, OfficeEntry } from "../src/office-activity.js";

export type OfficePose = "walking" | "typing" | "hand" | "idle" | "done" | "dead" | "asleep";

export type OfficeKind =
  | "claude"
  | "codex"
  | "copilot"
  | "agent"
  | "terminal"
  | "editor"
  | "browser"
  | "database"
  | "api"
  | "cluster"
  | "docker"
  | "chat";

/** What a click on the employee opens. */
export type OfficeTarget =
  | { type: "tab"; tabId: string }
  | { type: "pane"; tabId: string; paneKey: string }
  | { type: "session"; sessionId: string };

export type OfficeEmployee = {
  /** Stable across refreshes: `tab:<id>` or `session:<id>`. */
  key: string;
  kind: OfficeKind;
  /** The short mark on the desk's screen. */
  glyph: string;
  label: string;
  /** null: the Lounge. */
  project: string | null;
  pose: OfficePose;
  question?: string;
  doing?: string;
  agent?: string;
  model?: string;
  branch?: string;
  diff?: { added: number; removed: number; files?: number };
  lastActivityAt?: number;
  /** A hosted page's address and whether its page is asleep, for the card's
   *  preview. Only for a tab that has a page (not a terminal, API or Docker). */
  page?: { url: string; suspended: boolean };
  target: OfficeTarget;
};

export type RoomGeometry = {
  cols: number;
  rows: number;
  /** The room's box, in world pixels. */
  width: number;
  height: number;
  /** Where grid corner (0,0) sits inside the box. */
  ox: number;
  top: number;
};

export type OfficeRoom = {
  /** The project's name, or the Lounge's id. */
  id: string;
  name: string;
  lounge: boolean;
  employees: OfficeEmployee[];
  hands: number;
  geometry: RoomGeometry;
};

export type OfficeModel = {
  rooms: OfficeRoom[];
  /** Configured projects with nothing open, in config order. */
  closed: string[];
  totals: { employees: number; open: number; closed: number; hands: number };
};

export type OfficeInput = {
  /** Configured project names, in their stable order. */
  projects: readonly string[];
  workspace: WorkspaceState;
  sessions: readonly Session[];
  activity: OfficeActivity;
  /** Terminal tabs whose shell the renderer already knows runs a command. */
  runningTabs: ReadonlySet<string>;
  now: number;
};

/** How long an ended session without a tab stays on the floor. */
export const ENDED_VISIBLE_MS = 10 * 60 * 1000;
/** How long a starting session walks in before it sits down to type. */
export const STARTING_MS = 4000;
export const LOUNGE_ID = "Lounge";

const LIVE = new Set(["starting", "running", "waiting"]);

const GLYPHS: Record<OfficeKind, string> = {
  claude: ">_",
  codex: ">_",
  copilot: ">_",
  agent: ">_",
  terminal: "$_",
  editor: "{ }",
  browser: "www",
  database: "SQL",
  api: "API",
  cluster: "K8s",
  docker: "DKR",
  chat: "CHT",
};

const TAB_KINDS: Record<WorkspaceTab["kind"], OfficeKind> = {
  web: "browser",
  editor: "editor",
  database: "database",
  terminal: "terminal",
  api: "api",
  cluster: "cluster",
  docker: "docker",
  chat: "chat",
};

function agentKind(name: string | undefined): OfficeKind {
  if (name === undefined) return "agent";
  if (/claude/i.test(name)) return "claude";
  if (/codex/i.test(name)) return "codex";
  if (/copilot/i.test(name)) return "copilot";
  return "agent";
}

function sessionKind(session: Session): OfficeKind {
  return agentKind(session.agentId);
}

const tabIdOf = (paneKey: string): string => paneKey.split(":")[0] ?? paneKey;

/** A transcript-imported or otherwise historical row never shows; a live
 *  row found by the process scan does (it carries the pid it was found at). */
function isVisibleSession(session: Session, now: number): boolean {
  if (session.origin === "external") {
    if (session.pid === undefined) return false;
  } else if (session.transcriptPath !== undefined) {
    return false;
  }
  if (LIVE.has(session.state)) return true;
  return session.endedAt !== undefined && now - session.endedAt < ENDED_VISIBLE_MS;
}

function diffOf(session: Session | undefined): OfficeEmployee["diff"] {
  if (session === undefined) return undefined;
  const { insertions, deletions, changedFiles } = session;
  if (insertions === undefined && deletions === undefined && changedFiles === undefined) {
    return undefined;
  }
  return {
    added: insertions ?? 0,
    removed: deletions ?? 0,
    ...(changedFiles === undefined ? {} : { files: changedFiles }),
  };
}

function withDefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/** The entry that decides a tab's pose: a question beats busy beats idle. */
function strongest(entries: readonly [string, OfficeEntry][]): [string, OfficeEntry] | undefined {
  const rank = (entry: OfficeEntry): number =>
    entry.state === "question" ? 3 : entry.state === "busy" ? 2 : entry.state === "idle" ? 1 : 0;
  let best: [string, OfficeEntry] | undefined;
  for (const candidate of entries) {
    if (best === undefined || rank(candidate[1]) > rank(best[1])) best = candidate;
  }
  return best;
}

const PAGE_KINDS: ReadonlySet<string> = new Set(["web", "editor", "database", "cluster", "chat"]);

function tabEmployee(
  tab: WorkspaceTab,
  input: OfficeInput,
  merged: Session | undefined,
): OfficeEmployee {
  const paneEntries = Object.entries(input.activity.panes).filter(
    ([paneKey]) => tabIdOf(paneKey) === tab.id,
  );
  const mergedEntry = merged === undefined ? undefined : input.activity.sessions[merged.id];
  const best = strongest(paneEntries) ?? (mergedEntry ? [tab.id, mergedEntry] : undefined);
  const entry = best?.[1];
  const hasAgent = entry?.agent !== undefined || merged !== undefined;
  const kind: OfficeKind =
    tab.kind === "terminal" && hasAgent
      ? agentKind(entry?.agent ?? merged?.agentId)
      : TAB_KINDS[tab.kind];

  let pose: OfficePose;
  if (entry?.state === "question") pose = "hand";
  else if (tab.error !== undefined) pose = "dead";
  else if (tab.loading || entry?.state === "busy") pose = "typing";
  else if (
    tab.kind === "terminal" &&
    entry === undefined &&
    merged === undefined &&
    input.runningTabs.has(tab.id)
  ) {
    pose = "typing";
  } else if (tab.suspended) pose = "asleep";
  else pose = "idle";

  const questionPane = entry?.state === "question" ? best?.[0] : undefined;
  const target: OfficeTarget =
    questionPane !== undefined && questionPane !== tab.id
      ? { type: "pane", tabId: tab.id, paneKey: questionPane }
      : { type: "tab", tabId: tab.id };

  return withDefined({
    key: `tab:${tab.id}`,
    kind,
    glyph: GLYPHS[kind],
    label: tab.customTitle ?? (tab.title === "" ? tab.url : tab.title),
    project: tab.project === "" ? null : tab.project,
    pose,
    question: pose === "hand" ? entry?.question : undefined,
    doing: entry?.doing,
    agent: entry?.agent,
    model: entry?.model ?? merged?.model,
    branch: merged?.branch,
    diff: diffOf(merged),
    lastActivityAt: merged?.lastActivityAt,
    page: PAGE_KINDS.has(tab.kind) ? { url: tab.url, suspended: tab.suspended } : undefined,
    target,
  });
}

function sessionEmployee(session: Session, input: OfficeInput): OfficeEmployee {
  const entry = input.activity.sessions[session.id];
  const kind = sessionKind(session);
  let pose: OfficePose;
  if (entry?.state === "question") pose = "hand";
  else if (session.state === "dead") pose = "dead";
  else if (session.state === "done") pose = "done";
  else if (session.state === "starting" && input.now - session.startedAt < STARTING_MS) {
    pose = "walking";
  } else if (entry?.state === "idle" || session.state === "waiting") pose = "idle";
  else pose = "typing";
  return withDefined({
    key: `session:${session.id}`,
    kind,
    glyph: GLYPHS[kind],
    label: session.summary === "" ? session.agentId : session.summary,
    project: session.project,
    pose,
    question: pose === "hand" ? entry?.question : undefined,
    doing: entry?.doing ?? (session.summary === "" ? undefined : session.summary),
    agent: entry?.agent ?? session.agentId,
    model: entry?.model ?? session.model,
    branch: session.branch,
    diff: diffOf(session),
    lastActivityAt: session.lastActivityAt,
    target: { type: "session", sessionId: session.id },
  });
}

// ---- geometry -------------------------------------------------------------

const CELL_W = 124;
const CELL_H = 62;
const PAD_X = 40;
const PAD_TOP = 150;
const PAD_BOTTOM = 30;

/** The room for `count` employees: 2x1, 2x2, 3x2, 3x3, 4x3, 4x4 ... — columns
 *  and rows grow in turn, so a room always has at least as many seats. */
export function roomGeometry(count: number): RoomGeometry {
  let step = 0;
  for (;;) {
    const cols = 2 + Math.floor(step / 2);
    const rows = 1 + Math.floor((step + 1) / 2);
    if (cols * rows >= count) {
      const sum = cols + rows;
      return {
        cols,
        rows,
        width: sum * CELL_W + 2 * PAD_X,
        height: PAD_TOP + sum * CELL_H + PAD_BOTTOM,
        ox: PAD_X + rows * CELL_W,
        top: PAD_TOP,
      };
    }
    step += 1;
  }
}

/** A point of the room's floor grid, as a pixel inside its box. */
export function isoPoint(geometry: RoomGeometry, gx: number, gy: number): { x: number; y: number } {
  return {
    x: geometry.ox + (gx - gy) * CELL_W,
    y: geometry.top + (gx + gy) * CELL_H,
  };
}

/** The centre of seat `index`, row by row. */
export function seatPoint(geometry: RoomGeometry, index: number): { x: number; y: number } {
  return isoPoint(geometry, (index % geometry.cols) + 0.5, Math.floor(index / geometry.cols) + 0.5);
}

export type PlacedRoom = { x: number; y: number; width: number; height: number };

/** Rooms in rows of about sqrt(n), each row as tall as its tallest room and
 *  each room as wide as itself: big rooms never overlap their neighbours. */
export function worldLayout(geometries: readonly RoomGeometry[]): {
  rooms: PlacedRoom[];
  width: number;
  height: number;
} {
  const perRow = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(geometries.length))));
  const rooms: PlacedRoom[] = [];
  let y = 0;
  let width = 0;
  for (let start = 0; start < geometries.length; start += perRow) {
    const row = geometries.slice(start, start + perRow);
    let x = 0;
    let rowHeight = 0;
    for (const geometry of row) {
      rooms.push({ x, y, width: geometry.width, height: geometry.height });
      x += geometry.width;
      rowHeight = Math.max(rowHeight, geometry.height);
    }
    width = Math.max(width, x);
    y += rowHeight;
  }
  return { rooms, width, height: y };
}

// ---- the model --------------------------------------------------------------

export function buildOffice(input: OfficeInput): OfficeModel {
  const tabIds = new Set(input.workspace.tabs.map((tab) => tab.id));
  const merged = new Map<string, Session>();
  const lone: Session[] = [];
  for (const session of input.sessions) {
    if (!isVisibleSession(session, input.now)) continue;
    const key = session.terminalPaneKey;
    if (key !== undefined && tabIds.has(tabIdOf(key))) {
      if (LIVE.has(session.state)) merged.set(tabIdOf(key), session);
      continue;
    }
    lone.push(session);
  }

  const byProject = new Map<string | null, OfficeEmployee[]>();
  const add = (employee: OfficeEmployee): void => {
    const list = byProject.get(employee.project);
    if (list === undefined) byProject.set(employee.project, [employee]);
    else list.push(employee);
  };
  for (const tab of input.workspace.tabs) add(tabEmployee(tab, input, merged.get(tab.id)));
  for (const session of lone) add(sessionEmployee(session, input));

  // Config order first, then any other project a tab names, then the Lounge.
  const order: string[] = [...input.projects];
  for (const project of byProject.keys()) {
    if (project !== null && !order.includes(project)) order.push(project);
  }
  const rooms: OfficeRoom[] = [];
  const closed: string[] = [];
  for (const project of order) {
    const employees = byProject.get(project);
    if (employees === undefined || employees.length === 0) {
      if (input.projects.includes(project)) closed.push(project);
      continue;
    }
    rooms.push(roomOf(project, project, false, employees));
  }
  const lounge = byProject.get(null);
  if (lounge !== undefined && lounge.length > 0) {
    rooms.push(roomOf(LOUNGE_ID, LOUNGE_ID, true, lounge));
  }

  const hands = rooms.reduce((sum, room) => sum + room.hands, 0);
  return {
    rooms,
    closed,
    totals: {
      employees: rooms.reduce((sum, room) => sum + room.employees.length, 0),
      open: rooms.length,
      closed: closed.length,
      hands,
    },
  };
}

function roomOf(
  id: string,
  name: string,
  lounge: boolean,
  employees: OfficeEmployee[],
): OfficeRoom {
  return {
    id,
    name,
    lounge,
    employees,
    hands: employees.filter((employee) => employee.pose === "hand").length,
    geometry: roomGeometry(employees.length),
  };
}
