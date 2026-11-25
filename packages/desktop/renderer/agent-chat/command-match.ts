// What the `/` and `$` lists show and in which order: ranking of the
// commands for what is typed, the letters to mark, and where in the text the
// command name (or its argument) is. Pure; the composer owns the DOM.

import type { AgentCommandInfo } from "../../src/agent-suggest.js";

export type Hit = {
  command: AgentCommandInfo;
  rank: number;
  /** Indexes of the matched letters in the name (without the sigil). */
  indexes: number[];
};

const GROUPS: readonly AgentCommandInfo["source"][] = [
  "built-in",
  "project",
  "account",
  "skill",
  "plugin",
];
const WORD_START = /[:._-]/;

export const groupIndex = (source: AgentCommandInfo["source"]): number => GROUPS.indexOf(source);

function span(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

function matchName(name: string, query: string): { rank: number; indexes: number[] } | undefined {
  if (name === query) return { rank: 0, indexes: span(0, name.length) };
  if (name.startsWith(query)) return { rank: 2, indexes: span(0, query.length) };
  for (let at = 1; at < name.length; at++) {
    if (WORD_START.test(name.charAt(at - 1)) && name.startsWith(query, at)) {
      return { rank: 4, indexes: span(at, query.length) };
    }
  }
  const inside = name.indexOf(query);
  if (inside !== -1) return { rank: 5, indexes: span(inside, query.length) };
  const indexes: number[] = [];
  let from = 0;
  for (const letter of query) {
    const found = name.indexOf(letter, from);
    if (found === -1) return undefined;
    indexes.push(found);
    from = found + 1;
  }
  return { rank: 6, indexes };
}

export function rankCommands(
  list: readonly AgentCommandInfo[],
  query: string,
  trigger: "/" | "$",
): Hit[] {
  const needle = query.toLowerCase();
  const pool = list
    .map((command, order) => ({ command, order }))
    .filter(({ command }) => trigger === "/" || command.trigger === "$");
  if (needle === "") {
    return pool
      .sort(
        (a, b) => groupIndex(a.command.source) - groupIndex(b.command.source) || a.order - b.order,
      )
      .map(({ command }) => ({ command, rank: 0, indexes: [] }));
  }
  const hits: (Hit & { order: number })[] = [];
  for (const { command, order } of pool) {
    const byName = matchName(command.name.toLowerCase(), needle);
    if (byName !== undefined) {
      hits.push({ command, order, ...byName });
      continue;
    }
    if (command.aliases?.some((alias) => alias.toLowerCase().startsWith(needle)) === true) {
      hits.push({ command, order, rank: 1, indexes: [] });
      continue;
    }
    if (needle.length >= 2 && command.description?.toLowerCase().includes(needle) === true) {
      hits.push({ command, order, rank: 7, indexes: [] });
    }
  }
  return hits
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(b.command.source === "built-in") - Number(a.command.source === "built-in") ||
        a.command.name.length - b.command.name.length ||
        a.order - b.order,
    )
    .map(({ command, rank, indexes }) => ({ command, rank, indexes }));
}

export type NameToken = {
  kind: "name";
  trigger: "/" | "$";
  /** The typed part up to the caret: what filters. */
  query: string;
  /** The whole name, to the end of its letters: what a pick replaces. */
  full: string;
  start: number;
  end: number;
  atStart: boolean;
};
export type ArgToken = {
  kind: "arg";
  name: string;
  query: string;
  start: number;
  end: number;
};

/** What the caret is in: a command name (`/` at a word start, `$` for Codex),
 *  or the first argument of a command typed at the start of the message. */
export function readToken(
  value: string,
  caret: number,
  allowDollar: boolean,
): NameToken | ArgToken | undefined {
  const before = value.slice(0, caret);
  const name = /(^|\s)([/$])([\w:.-]*)$/.exec(before);
  if (name !== null) {
    const trigger = name[2] === "$" ? "$" : "/";
    if (trigger === "$" && !allowDollar) return undefined;
    const start = (name.index ?? 0) + (name[1]?.length ?? 0);
    const tail = /^[\w:.-]*/.exec(value.slice(caret))?.[0] ?? "";
    const end = caret + tail.length;
    // `/usr/local`: a path, not a command.
    if (value.charAt(end) === "/") return undefined;
    const query = name[3] ?? "";
    return {
      kind: "name",
      trigger,
      query,
      full: `${query}${tail}`,
      start,
      end,
      atStart: start === 0,
    };
  }
  const arg = /^\/([A-Za-z][\w:.-]*) (\S*)$/.exec(before);
  if (arg !== null) {
    const query = arg[2] ?? "";
    const tail = /^\S*/.exec(value.slice(caret))?.[0] ?? "";
    return {
      kind: "arg",
      name: arg[1] ?? "",
      query,
      start: caret - query.length,
      end: caret + tail.length,
    };
  }
  return undefined;
}

/** The argument words the CLI documents for a command typed by name or alias,
 *  filtered by what is typed. Nothing a CLI did not document is ever listed. */
export function argumentChoices(
  list: readonly AgentCommandInfo[],
  name: string,
  query: string,
): string[] {
  const command = list.find(
    (candidate) =>
      candidate.trigger === undefined &&
      (candidate.name === name || candidate.aliases?.includes(name) === true),
  );
  const needle = query.toLowerCase();
  return (command?.choices ?? []).filter((choice) => choice.toLowerCase().includes(needle));
}
