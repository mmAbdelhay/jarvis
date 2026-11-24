// What is on an Office employee's screen right now, for the hover card
// (office:screen). Desktop-only and read-only: it looks at what the pane's
// headless screen (pane-screen.ts) or the retained log already holds, and
// starts, notices, follows and writes nothing. Nothing it reads is ever
// logged — only category tokens — and it is never pushed to a phone.

import { stripAnsi } from "@jarvis/core";

/** At most this many rows, from the bottom of the screen. */
export const OFFICE_SCREEN_ROWS = 16;
/** At most this many characters per row. */
export const OFFICE_SCREEN_COLS = 200;
/** At most this many panes of a split tab. */
export const OFFICE_SCREEN_PANES = 4;
const KEY_MAX = 200;
/** Only the end of a long log is ever looked at. */
const LOG_TAIL_CHARS = 16_000;

export type OfficeScreenTarget = { type: "tab" | "pane" | "session"; id: string };

export type OfficeScreenSection = {
  paneKey: string;
  /** The agent's own name, when one runs in the pane. */
  agent?: string;
  lines: string[];
};

export type OfficeScreen =
  | { kind: "none" }
  | { kind: "terminal"; sections: OfficeScreenSection[] }
  | { kind: "session"; lines: string[] };

export type OfficeScreenDeps = {
  tabs(): readonly { id: string; kind: string }[];
  panes(): readonly { paneKey: string; exited: boolean }[];
  /** pane-screen.ts's screenText: undefined for a pane with no screen yet. */
  screenText(paneKey: string): string | undefined;
  /** The pane's retained output. */
  paneLog(paneKey: string): string;
  sessions(): readonly { id: string }[];
  sessionLog(sessionId: string): string;
  /** The agent's name for a pane, from what the Office already read. */
  agentOf(paneKey: string): string | undefined;
  /** A category token, never content. */
  log(token: string): void;
};

const NONE: OfficeScreen = { kind: "none" };
const tabIdOf = (paneKey: string): string => paneKey.split(":")[0] ?? paneKey;

function isTarget(value: unknown): value is OfficeScreenTarget {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  if (type !== "tab" && type !== "pane" && type !== "session") return false;
  return typeof id === "string" && id !== "" && id.length <= KEY_MAX;
}

/** Control characters out (a tab becomes a space), at most one row's width. */
function cleanRow(row: string): string {
  let kept = "";
  for (const char of stripAnsi(row.replace(/\t/g, " "))) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) kept += char;
  }
  return kept.trimEnd().slice(0, OFFICE_SCREEN_COLS);
}

/** The last rows of `text`, cleaned, with no blank rows at the end. */
function tailRows(text: string, fromLog: boolean): string[] {
  const source = fromLog ? text.slice(-LOG_TAIL_CHARS) : text;
  const rows = source
    .trimEnd()
    .split("\n")
    .slice(-OFFICE_SCREEN_ROWS * 4)
    .map((row) => {
      if (!fromLog) return cleanRow(row);
      // A carriage return redraws the row: only what follows the last one shows.
      const trimmed = row.endsWith("\r") ? row.slice(0, -1) : row;
      return cleanRow(trimmed.slice(trimmed.lastIndexOf("\r") + 1));
    });
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.slice(-OFFICE_SCREEN_ROWS);
}

export function createOfficeScreen(deps: OfficeScreenDeps): {
  read(target: unknown): OfficeScreen;
} {
  function log(token: string): void {
    try {
      deps.log(`office-screen: ${token}`);
    } catch {
      // A failing logger changes nothing.
    }
  }

  function section(paneKey: string): OfficeScreenSection {
    let screen: string | undefined;
    try {
      screen = deps.screenText(paneKey);
    } catch {
      screen = undefined;
    }
    const lines =
      screen !== undefined ? tailRows(screen, false) : tailRows(deps.paneLog(paneKey), true);
    const agent = deps.agentOf(paneKey);
    return { paneKey, ...(agent === undefined ? {} : { agent }), lines };
  }

  function terminal(tabId: string, first: string | undefined): OfficeScreen {
    const live = deps
      .panes()
      .filter((pane) => !pane.exited && tabIdOf(pane.paneKey) === tabId)
      .map((pane) => pane.paneKey);
    if (first !== undefined) {
      if (!live.includes(first)) return NONE;
      live.splice(live.indexOf(first), 1);
      live.unshift(first);
    }
    return {
      kind: "terminal",
      sections: live.slice(0, OFFICE_SCREEN_PANES).map(section),
    };
  }

  return {
    read(target) {
      if (!isTarget(target)) return NONE;
      try {
        const terminals = new Set(
          deps
            .tabs()
            .filter((tab) => tab.kind === "terminal")
            .map((tab) => tab.id),
        );
        if (target.type === "tab") {
          return terminals.has(target.id) ? terminal(target.id, undefined) : NONE;
        }
        if (target.type === "pane") {
          const tabId = tabIdOf(target.id);
          return terminals.has(tabId) ? terminal(tabId, target.id) : NONE;
        }
        if (!deps.sessions().some((session) => session.id === target.id)) return NONE;
        return { kind: "session", lines: tailRows(deps.sessionLog(target.id), true) };
      } catch {
        log("read");
        return NONE;
      }
    },
  };
}
