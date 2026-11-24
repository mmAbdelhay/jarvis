// The desktop's agent chat document (terminal:agentChat): the session's
// transcript as ordered items, the side panel's derived data, and what the
// pane's screen shows right now — all for the Chat view of a pane running
// Claude Code, Copilot or Codex.
//
// The transcript is read incrementally: once per session the whole file is
// fed, in chunks of at most 1 MB through a streaming UTF-8 decoder, to a
// platform reader (agent-chat-doc.ts in @jarvis/platform); afterwards only
// the bytes appended since. Pages are served out of that document, so an item
// has the same id whichever way it was read and a tool call always shows the
// result that came after it. Only items older than the reader's cap are read
// backwards from disk, in 2 MB windows. Nothing here logs a path, a session
// name, or any transcript, screen or typed text — only category tokens, and
// no keys ever leave this file.

import { readAgentMenu, readClaudeMode } from "@jarvis/core";
import {
  type ChatAgent,
  type ChatAsking,
  type ChatDoc,
  type ChatDocReader,
  type ChatFile,
  type ChatItem,
  type ChatTodo,
  createClaudeDocReader,
  createCodexDocReader,
  createCopilotDocReader,
  parseClaudeDoc,
  parseCodexDoc,
  parseCopilotDoc,
} from "@jarvis/platform";
import type { ClaudeMode } from "@jarvis/wire";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname } from "node:path";
import { type AgentLimit, readAgentStatusLine } from "./agent-status-line.js";
import { type AgentVendor, isMissingFile, readAgentScreen } from "./agent-view.js";
import { sameAgentSession, type PaneAgentSession } from "./pane-agent-session.js";

const MB = 1024 * 1024;
const PAGE_ITEMS = 200;
const MAX_ENTRIES = 8;
const MAX_WINDOWS = 64;

export type AgentChatLimits = {
  /** Items kept in memory per session (the reader's cap). */
  maxItems?: number;
  /** The most one backwards disk read covers. */
  stepBytes?: number;
  /** Up to this size the first reply waits for the whole file. */
  syncBytes?: number;
  /** The most one forward read returns. */
  chunkBytes?: number;
};

export type AgentChatDeps = {
  sessions: {
    session(paneKey: string, fresh?: boolean): Promise<PaneAgentSession | undefined>;
    live(paneKey: unknown): boolean;
  };
  statFile(path: string): Promise<{ size: number; mtimeMs: number; ino?: number }>;
  /** The bytes [start, start + length) of a file, fewer at its end. */
  readRange(path: string, start: number, length: number): Promise<Buffer>;
  screenText(paneKey: string): string | undefined;
  notice(paneKey: string): void;
  follow(paneKey: string, transcript: { dir: string; file: string }): void;
  forget(paneKey: string): void;
  /** The background read finished: look again. */
  changed?(paneKey: string): void;
  log(token: string): void;
  limits?: AgentChatLimits;
  /** The clock, in ms (tests set it). */
  now?: () => number;
};

/** Which controls work for a vendor; the renderer shows only these. */
export type AgentChatCaps = {
  stop: boolean;
  mode: boolean;
  /** `command`: `/model x` sets it; `menu`: the agent opens its own picker. */
  model: "command" | "menu";
  commands: boolean;
  files: boolean;
  attach: boolean;
  /** A message sent while the agent works is queued by the agent. */
  queue: boolean;
};

const CAPS: Record<AgentVendor, AgentChatCaps> = {
  anthropic: {
    stop: true,
    mode: true,
    model: "command",
    commands: true,
    files: true,
    attach: true,
    queue: true,
  },
  openai: {
    stop: true,
    mode: false,
    model: "menu",
    commands: true,
    files: true,
    attach: true,
    queue: false,
  },
  github: {
    stop: false,
    mode: false,
    model: "menu",
    commands: true,
    files: true,
    attach: true,
    queue: false,
  },
};

/** A pending menu as the card shows it: labels only, never keys. */
export type AgentChatPrompt = {
  kind: "single" | "multi";
  question: string;
  body?: string;
  options: { label: string; highlighted: boolean }[];
};

export type AgentChatView =
  | { kind: "none" }
  | {
      kind: "agent";
      vendor: AgentVendor;
      sessionId: string;
      title?: string;
      model?: string;
      mode?: ClaudeMode;
      working?: string;
      prompt?: AgentChatPrompt;
      /** A menu only the terminal can answer (the drawer). */
      needsTerm?: true;
      page: { items: ChatItem[]; older?: string };
      /** The file was truncated or replaced, or the cursor was not this one's. */
      reset?: true;
      todos?: ChatTodo[];
      agents: ChatAgent[];
      files: ChatFile[];
      context?: { used: number; leftPercent?: number };
      /** The agent's own status line and usage limits; `stale`: the screen
       *  shows none right now and these are the last it showed. */
      status?: { lines: string[]; limits: AgentLimit[]; stale?: true };
      /** The question or plan the agent is waiting on, read-only. */
      asking?: ChatAsking;
      /** The whole file is still being read: side data fills in later. */
      deriving?: true;
      /** This read failed; the page is the last good one (empty if none). */
      readFailed?: true;
      caps: AgentChatCaps;
    };

export type AgentChatRequest = { before?: string };

type Cursor = { v: 1; s: string; p: string; k: "mem" | "disk"; id?: string; end?: number };

type Entry = {
  paneKey: string;
  sessionId: string;
  path: string;
  vendor: AgentVendor;
  reader: ChatDocReader;
  decoder: StringDecoder;
  offset: number;
  ino: number | undefined;
  ready: boolean;
  reading: Promise<void> | undefined;
  /** The reader was restarted since the last reply. */
  restarted: boolean;
  /** The file shrank or was replaced: only the running read restarts, between reads. */
  restartWanted: boolean;
  used: number;
  doc: { offset: number; value: ChatDoc } | undefined;
};

function readerFor(vendor: AgentVendor, maxItems: number): ChatDocReader {
  if (vendor === "github") return createCopilotDocReader({ maxItems });
  if (vendor === "openai") return createCodexDocReader({ maxItems });
  return createClaudeDocReader({ maxItems });
}

function parserFor(vendor: AgentVendor): (text: string, maxItems: number) => ChatDoc {
  if (vendor === "github") return (text, maxItems) => parseCopilotDoc(text, { maxItems });
  if (vendor === "openai") return (text, maxItems) => parseCodexDoc(text, { maxItems });
  return (text, maxItems) => parseClaudeDoc(text, { maxItems });
}

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decode(raw: unknown): Cursor | undefined {
  if (typeof raw !== "string" || raw.length > 2048) return undefined;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (value["v"] !== 1 || typeof value["s"] !== "string" || typeof value["p"] !== "string") {
      return undefined;
    }
    if (value["k"] !== "mem" && value["k"] !== "disk") return undefined;
    const cursor: Cursor = { v: 1, s: value["s"], p: value["p"], k: value["k"] };
    if (typeof value["id"] === "string") cursor.id = value["id"];
    if (typeof value["end"] === "number" && Number.isFinite(value["end"]))
      cursor.end = value["end"];
    return cursor;
  } catch {
    return undefined;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A reset time of the transcript as the screen words it: "04:20" today, "Wed 22:00" later. */
function resetText(epochSeconds: number, nowMs: number): string {
  const at = new Date(epochSeconds * 1000);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  const today = new Date(nowMs);
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return `${hh}:${mm}`;
  if (at.getTime() - nowMs > 6 * 24 * 3600 * 1000) {
    return `${at.getDate()} ${MONTHS[at.getMonth()]} ${hh}:${mm}`;
  }
  return `${WEEKDAYS[at.getDay()]} ${hh}:${mm}`;
}

/** The transcript's limits that have not reset yet, worded like the screen's. */
function transcriptLimits(limits: ChatDoc["limits"], nowMs: number): AgentLimit[] {
  const out: AgentLimit[] = [];
  for (const limit of limits ?? []) {
    if (limit.resetsAt !== undefined && limit.resetsAt * 1000 <= nowMs) continue;
    out.push({
      label: limit.label,
      usedPercent: limit.usedPercent,
      ...(limit.resetsAt === undefined ? {} : { resets: resetText(limit.resetsAt, nowMs) }),
    });
  }
  return out;
}

/** "Context left until auto-compact: 12%" (Claude) or "87% context left" (Codex). */
function leftPercent(vendor: AgentVendor, screen: string): number | undefined {
  const pattern =
    vendor === "anthropic"
      ? /Context left until auto-compact:\s*(\d{1,3})%/i
      : vendor === "openai"
        ? /(\d{1,3})%\s+context left/i
        : undefined;
  const found = pattern?.exec(screen)?.[1];
  if (found === undefined) return undefined;
  const value = Number(found);
  return value >= 0 && value <= 100 ? value : undefined;
}

export function createAgentChatHandlers(deps: AgentChatDeps): {
  chat(paneKey: unknown, request?: unknown): Promise<AgentChatView>;
  forgetPane(paneKey: string): void;
  /** How many sessions are held (for tests). */
  cached(): number;
} {
  const maxItems = deps.limits?.maxItems ?? 5_000;
  const step = deps.limits?.stepBytes ?? 2 * MB;
  const syncBytes = deps.limits?.syncBytes ?? 2 * MB;
  const chunk = deps.limits?.chunkBytes ?? MB;
  const entries = new Map<string, Entry>();
  /** The last mode the screen proved, per session: a menu hides the status row. */
  const lastMode = new Map<string, ClaudeMode>();
  type AgentView = Extract<AgentChatView, { kind: "agent" }>;
  /** The last good reply per pane, shown again when a read fails. */
  const lastGood = new Map<string, AgentView>();
  /** The session behind each lastGood, to tell a pending id from its real one. */
  const lastSession = new Map<string, PaneAgentSession>();
  /** The last status the screen showed, per pane, for the session that showed it. */
  const lastStatus = new Map<
    string,
    { session: PaneAgentSession; lines: string[]; limits: AgentLimit[] }
  >();
  let tick = 0;

  function log(token: string): void {
    try {
      deps.log(`agent-chat: ${token}`);
    } catch {
      // A failing logger cannot turn a refusal into a throw.
    }
  }

  function drop(sessionId: string): void {
    entries.delete(sessionId);
  }

  function touch(entry: Entry): void {
    entry.used = ++tick;
    while (entries.size > MAX_ENTRIES) {
      let oldest: Entry | undefined;
      for (const candidate of entries.values()) {
        if (candidate !== entry && (oldest === undefined || candidate.used < oldest.used)) {
          oldest = candidate;
        }
      }
      if (oldest === undefined) break;
      entries.delete(oldest.sessionId);
    }
  }

  function restart(entry: Entry): void {
    entry.reader = readerFor(entry.vendor, maxItems);
    entry.decoder = new StringDecoder("utf8");
    entry.offset = 0;
    entry.ready = false;
    entry.restarted = true;
    entry.restartWanted = false;
    entry.doc = undefined;
  }

  const replacedOrShrunk = (
    entry: Entry,
    stat: { size: number; ino?: number | undefined },
  ): boolean =>
    stat.size < entry.offset ||
    (entry.ino !== undefined && stat.ino !== undefined && stat.ino !== entry.ino);

  /** Feeds every byte appended since the last read; one run at a time. */
  function advance(entry: Entry): Promise<void> {
    if (entry.reading !== undefined) return entry.reading;
    const run = (async () => {
      for (let again = 0; again < 4; again++) {
        const stat = await deps.statFile(entry.path);
        if (entry.restartWanted || replacedOrShrunk(entry, stat)) restart(entry);
        entry.ino = stat.ino;
        while (entry.offset < stat.size) {
          const length = Math.min(chunk, stat.size - entry.offset);
          const bytes = await deps.readRange(entry.path, entry.offset, length);
          // The file was replaced while this read ran: its bytes are another
          // file's, so they never reach the reader.
          if (entry.restartWanted) break;
          if (bytes.length === 0) break;
          entry.reader.push(entry.decoder.write(bytes));
          entry.offset += bytes.length;
        }
        if (entry.restartWanted) continue;
        const after = await deps.statFile(entry.path);
        if (replacedOrShrunk(entry, after)) {
          entry.restartWanted = true;
          continue;
        }
        if (after.size <= entry.offset) break;
      }
      entry.ready = !entry.restartWanted;
      entry.doc = undefined;
    })();
    const tracked = run.finally(() => {
      entry.reading = undefined;
    });
    entry.reading = tracked;
    return tracked;
  }

  function currentDoc(entry: Entry): ChatDoc {
    if (entry.doc?.offset !== entry.offset) {
      entry.doc = { offset: entry.offset, value: entry.reader.doc() };
    }
    return entry.doc.value;
  }

  /** The document for a reply: whole when small or ready, else the file's tail. */
  async function documentFor(
    session: PaneAgentSession,
    path: string,
  ): Promise<{ entry: Entry; doc: ChatDoc; deriving: boolean }> {
    let entry = entries.get(session.sessionId);
    if (entry !== undefined && entry.path !== path) {
      drop(session.sessionId);
      entry = undefined;
    }
    if (entry === undefined) {
      entry = {
        paneKey: session.paneKey,
        sessionId: session.sessionId,
        path,
        vendor: session.vendor,
        reader: readerFor(session.vendor, maxItems),
        decoder: new StringDecoder("utf8"),
        offset: 0,
        ino: undefined,
        ready: false,
        reading: undefined,
        restarted: false,
        restartWanted: false,
        used: 0,
        doc: undefined,
      };
      entries.set(session.sessionId, entry);
    }
    entry.paneKey = session.paneKey;
    touch(entry);
    const stat = await deps.statFile(path);
    const behind = stat.size - entry.offset;
    const replaced = entry.ino !== undefined && stat.ino !== undefined && stat.ino !== entry.ino;
    if (stat.size < entry.offset || replaced) {
      // Never restarted here: a read may be running. The next read does it.
      entry.restartWanted = true;
      entry.ready = false;
    }
    if (!entry.ready && stat.size > syncBytes) {
      // Too big to wait for: the first reply comes from the tail, the rest is
      // read in the background and announced when done.
      void advance(entry)
        .then(() => deps.changed?.(entry.paneKey))
        .catch(() => log("read"));
      const start = Math.max(0, stat.size - step);
      const bytes = await deps.readRange(path, start, stat.size - start);
      const tail = parserFor(session.vendor)(new StringDecoder("utf8").write(bytes), maxItems);
      return { entry, doc: tail, deriving: true };
    }
    if (entry.ready && behind > syncBytes) {
      void advance(entry)
        .then(() => deps.changed?.(entry.paneKey))
        .catch(() => log("read"));
    } else {
      await advance(entry);
      // A read that was already running ended before it saw the change.
      for (let again = 0; again < 3 && entry.restartWanted; again++) await advance(entry);
    }
    return { entry, doc: currentDoc(entry), deriving: !entry.ready };
  }

  /** Items older than the in-memory cap, read backwards in windows. */
  async function diskPage(
    entry: Entry,
    beforeId: string | undefined,
    end: number | undefined,
  ): Promise<{ items: ChatItem[]; older?: string }> {
    const parse = parserFor(entry.vendor);
    let to = end ?? (await deps.statFile(entry.path)).size;
    let found = beforeId === undefined;
    for (let window = 0; window < MAX_WINDOWS && to > 0; window++) {
      const from = Math.max(0, to - step);
      const bytes = await deps.readRange(entry.path, from, to - from);
      let start = 0;
      if (from > 0) {
        const newline = bytes.indexOf(10);
        start = newline === -1 ? bytes.length : newline + 1;
      }
      const lineStart = from + start;
      const text = new StringDecoder("utf8").write(bytes.subarray(start));
      let items = parse(text, 50_000).items;
      if (!found && beforeId !== undefined) {
        const at = items.findIndex((item) => item.id === beforeId);
        if (at !== -1) {
          items = items.slice(0, at);
          found = true;
        } else items = [];
      }
      const next = lineStart > 0 && lineStart < to ? lineStart : from;
      if (found && items.length > 0) {
        return {
          items,
          ...(next > 0
            ? { older: encode({ v: 1, s: entry.sessionId, p: entry.path, k: "disk", end: next }) }
            : {}),
        };
      }
      to = next;
    }
    return { items: [] };
  }

  async function page(
    entry: Entry,
    doc: ChatDoc,
    request: AgentChatRequest,
  ): Promise<{ items: ChatItem[]; older?: string; reset?: true }> {
    const all = doc.items;
    const atCap = all.length >= maxItems;
    const mem = (id: string): string =>
      encode({ v: 1, s: entry.sessionId, p: entry.path, k: "mem", id });
    const disk = (id: string | undefined, end?: number): string =>
      encode({
        v: 1,
        s: entry.sessionId,
        p: entry.path,
        k: "disk",
        ...(id !== undefined ? { id } : {}),
        ...(end !== undefined ? { end } : {}),
      });
    const latest = (reset: boolean) => {
      const items = all.slice(-PAGE_ITEMS);
      const first = items[0];
      const older =
        first === undefined
          ? undefined
          : all.length > items.length
            ? mem(first.id)
            : atCap
              ? disk(first.id)
              : undefined;
      return {
        items,
        ...(older === undefined ? {} : { older }),
        ...(reset ? { reset: true as const } : {}),
      };
    };

    if (request.before === undefined) return latest(entry.restarted);
    const cursor = decode(request.before);
    if (cursor === undefined || cursor.s !== entry.sessionId || cursor.p !== entry.path) {
      return latest(true);
    }
    if (cursor.k === "disk") {
      const out = await diskPage(
        entry,
        cursor.end === undefined ? cursor.id : undefined,
        cursor.end,
      );
      return out;
    }
    const at = all.findIndex((item) => item.id === cursor.id);
    if (at === -1) {
      return cursor.id === undefined ? latest(true) : await diskPage(entry, cursor.id, undefined);
    }
    const items = all.slice(Math.max(0, at - PAGE_ITEMS), at);
    const first = items[0];
    if (first === undefined) {
      return atCap ? await diskPage(entry, cursor.id, undefined) : { items: [] };
    }
    const older = at - PAGE_ITEMS > 0 ? mem(first.id) : atCap ? disk(first.id) : undefined;
    return { items, ...(older === undefined ? {} : { older }) };
  }

  return {
    cached: () => entries.size,
    forgetPane(paneKey) {
      for (const [id, entry] of entries) if (entry.paneKey === paneKey) entries.delete(id);
      lastGood.delete(paneKey);
      lastSession.delete(paneKey);
      lastStatus.delete(paneKey);
    },

    async chat(paneKey, request) {
      let known: PaneAgentSession | undefined;
      try {
        if (typeof paneKey !== "string" || !deps.sessions.live(paneKey)) {
          if (typeof paneKey === "string") lastGood.delete(paneKey);
          return { kind: "none" };
        }
        const session = await deps.sessions.session(paneKey);
        if (session === undefined || !deps.sessions.live(paneKey)) {
          lastGood.delete(paneKey);
          return { kind: "none" };
        }
        known = session;
        try {
          deps.notice(paneKey);
        } catch {
          log("notice");
        }
        const transcriptPath = session.transcriptPath;
        if (transcriptPath !== undefined) {
          try {
            deps.follow(paneKey, { dir: dirname(transcriptPath), file: basename(transcriptPath) });
          } catch {
            log("follow");
          }
        }
        const screen = deps.screenText(paneKey) ?? "";
        const state = readAgentScreen(session.vendor, screen);
        const menu = readAgentMenu(screen, session.vendor);

        let doc: ChatDoc = { items: [], agents: [], files: [] };
        let pageOut: { items: ChatItem[]; older?: string; reset?: true } = { items: [] };
        let deriving = false;
        if (transcriptPath !== undefined) {
          try {
            const got = await documentFor(session, transcriptPath);
            doc = got.doc;
            deriving = got.deriving;
            const asked =
              request !== null && typeof request === "object" ? (request as AgentChatRequest) : {};
            pageOut = await page(got.entry, doc, asked);
            got.entry.restarted = false;
          } catch (error) {
            // Not written yet (Copilot before the first message): an empty
            // session, and the file loads once it exists. Anything else keeps
            // the read-failed note.
            if (!isMissingFile(error)) throw error;
            drop(session.sessionId);
            doc = { items: [], agents: [], files: [] };
            pageOut = { items: [] };
            deriving = false;
          }
        }

        const left = leftPercent(session.vendor, screen);
        const prompt: AgentChatPrompt | undefined =
          menu?.kind === "single" || menu?.kind === "multi"
            ? {
                kind: menu.kind,
                question: menu.question,
                ...(menu.body === undefined ? {} : { body: menu.body }),
                options: menu.options.map(({ label, highlighted }) => ({ label, highlighted })),
              }
            : undefined;
        // Only a mode the screen proves; while a menu hides the row, the last one
        // that was proven for this very session. Never a guess.
        let mode: ClaudeMode | undefined;
        if (session.vendor === "anthropic") {
          mode = readClaudeMode(screen) ?? lastMode.get(session.sessionId);
          if (mode !== undefined) {
            lastMode.delete(session.sessionId);
            lastMode.set(session.sessionId, mode);
            while (lastMode.size > MAX_ENTRIES * 4) {
              const oldest = lastMode.keys().next().value;
              if (oldest === undefined) break;
              lastMode.delete(oldest);
            }
          }
        }
        const read = readAgentStatusLine(session.vendor, screen);
        const fromTranscript = transcriptLimits(doc.limits, (deps.now ?? Date.now)());
        let status: AgentView["status"];
        if (read.lines.length > 0 || read.limits.length > 0) {
          lastStatus.set(paneKey, { session, lines: read.lines, limits: read.limits });
          status = { lines: read.lines, limits: read.limits };
        } else {
          const kept = lastStatus.get(paneKey);
          if (kept !== undefined && sameAgentSession(kept.session, session)) {
            status = { lines: kept.lines, limits: kept.limits, stale: true };
          } else {
            lastStatus.delete(paneKey);
          }
        }
        if (fromTranscript.length > 0) {
          const seen = new Set((status?.limits ?? []).map((limit) => limit.label.toLowerCase()));
          const limits = [
            ...(status?.limits ?? []),
            ...fromTranscript.filter((limit) => !seen.has(limit.label.toLowerCase())),
          ];
          status = {
            lines: status?.lines ?? [],
            limits,
            ...(status?.stale ? { stale: true as const } : {}),
          };
        }
        const needsTerm = menu?.kind === "unreadable" || (menu === undefined && state.needsTerm);
        const view: AgentView = {
          kind: "agent",
          vendor: session.vendor,
          sessionId: session.sessionId,
          ...(session.name === undefined ? {} : { title: session.name }),
          ...(doc.model === undefined ? {} : { model: doc.model }),
          ...(mode === undefined ? {} : { mode }),
          ...(state.working === undefined ? {} : { working: state.working }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(needsTerm ? { needsTerm: true as const } : {}),
          page: {
            items: pageOut.items,
            ...(pageOut.older === undefined ? {} : { older: pageOut.older }),
          },
          ...(pageOut.reset === true ? { reset: true as const } : {}),
          ...(deriving || doc.todos === undefined ? {} : { todos: doc.todos }),
          agents: deriving ? [] : doc.agents,
          files: deriving ? [] : doc.files,
          ...(doc.contextTokens === undefined
            ? {}
            : {
                context: {
                  used: doc.contextTokens,
                  ...(left === undefined ? {} : { leftPercent: left }),
                },
              }),
          ...(status === undefined ? {} : { status }),
          ...(doc.asking === undefined ? {} : { asking: doc.asking }),
          ...(deriving ? { deriving: true as const } : {}),
          caps: CAPS[session.vendor],
        };
        lastGood.set(paneKey, view);
        lastSession.set(paneKey, session);
        return view;
      } catch {
        log("read");
        // A transient failure must not make the chat vanish: the last good
        // reply (or an empty one for the same agent) says the read failed.
        const previous = typeof paneKey === "string" ? lastGood.get(paneKey) : undefined;
        if (
          previous !== undefined &&
          (known === undefined ||
            known.sessionId === previous.sessionId ||
            sameAgentSession(known, lastSession.get(paneKey as string) ?? known))
        ) {
          return { ...previous, readFailed: true };
        }
        if (known === undefined) return { kind: "none" };
        return {
          kind: "agent",
          vendor: known.vendor,
          sessionId: known.sessionId,
          ...(known.name === undefined ? {} : { title: known.name }),
          page: { items: [] },
          agents: [],
          files: [],
          caps: CAPS[known.vendor],
          readFailed: true,
        };
      }
    },
  };
}
