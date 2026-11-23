// What each agent in the Office is doing right now, read in the main process
// (the watcher below) and drawn by renderer/office-model.ts and
// office-view.ts. Nothing here is ever logged but category tokens.
//
// One shared watcher: at most one scan per OFFICE_SCAN_MS, and only if some
// pane or session printed since the last scan or a question is open — a
// quiet app, or one with no live pane or session, does no reading at all.
// A scan reads only the panes and sessions that printed (or have an open
// question) and reuses every other entry; a pane where no agent was found
// is looked up again at most every OFFICE_NONE_MS; a failed read keeps the
// previous entry. Panes are read through the Chat view's own side-effect-free
// reader (agent-view.ts's peek); sessions
// Jarvis spawned through readPrompt/readAgentInputState on the tail of their
// retained output. A change pushes `office:changed` (no content); a pane or
// session newly asking raises a desktop notification that names the project
// and the agent, never the question.

import { type Session, readAgentInputState, readPrompt, stripAnsi } from "@jarvis/core";
import type { AgentView } from "./agent-view.js";
import { MESSAGES } from "./messages.js";

/** One pane's or session's state. "question" also covers an approval menu
 *  that cannot be read (no question text then). "unknown": the read failed. */
export type OfficeState = "question" | "busy" | "idle" | "unknown";

export type OfficeEntry = {
  /** The agent's own name: "Claude Code", "Copilot" or "Codex". */
  agent?: string;
  state: OfficeState;
  /** At most 200 characters, control characters stripped. Never in a
   *  notification. */
  question?: string;
  doing?: string;
  model?: string;
};

export type OfficeActivity = {
  panes: Record<string, OfficeEntry>;
  sessions: Record<string, OfficeEntry>;
};

export const EMPTY_OFFICE_ACTIVITY: OfficeActivity = { panes: {}, sessions: {} };

/** At most one scan this often. */
export const OFFICE_SCAN_MS = 3000;
/** A pane with no agent is looked up again no sooner than this. */
export const OFFICE_NONE_MS = 15_000;
/** A repeat hand for the same target inside this window is not announced. */
export const OFFICE_NOTIFY_COALESCE_MS = 60_000;
export const OFFICE_QUESTION_MAX = 200;
const VIEWING_MAX = 64;
const KEY_MAX = 200;
const DIRTY_MAX = 512;
const TAIL_ROWS = 40;
const LIVE = new Set(["starting", "running", "waiting"]);
const VENDOR_NAMES = { anthropic: "Claude Code", github: "Copilot", openai: "Codex" } as const;

type AgentOf = Extract<AgentView, { kind: "agent" }>;

export type OfficeActivityDeps = {
  panes(): readonly { paneKey: string; exited: boolean }[];
  /** agent-view.ts's peek: a pane's agent and what its screen shows, with
   *  no effect on what is watched. Throws when the read fails. */
  agentView(paneKey: string): Promise<AgentView>;
  /** Every session row; only live ones Jarvis spawned itself are read. */
  sessions(): readonly Session[];
  /** A session's retained output. */
  sessionLog(sessionId: string): string;
  /** The vendor of a registered agent id, for the input-state read. */
  vendorOf(agentId: string): string | undefined;
  /** The project a tab (or session) belongs to; null: none. */
  projectOf(target: string): string | null;
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
  /** `office:changed`, to this window only. No content. */
  emitChanged(): void;
  /** The host's desktop notification. */
  notify(title: string, body: string): void;
  focused(): boolean;
  /** Tab ids and session ids the window shows right now. */
  viewing(): ReadonlySet<string>;
  language: "ar" | "en";
  /** A category token, never content. */
  log(token: string): void;
};

export type OfficeWatcher = {
  /** The latest answer; scans first if there is none or output waits. */
  read(): Promise<OfficeActivity>;
  /** `key` (a pane key or session id) printed; no key: something came or
   *  went, so every pane and session is read. */
  markDirty(key?: string): void;
  stop(): void;
};

/** The tab ids and session ids the window reports as on screen, validated. */
export function createOfficeViewing(): {
  set(keys: unknown): void;
  keys(): ReadonlySet<string>;
} {
  let current: ReadonlySet<string> = new Set();
  return {
    set(keys) {
      const next = new Set<string>();
      if (Array.isArray(keys)) {
        for (const key of keys) {
          if (next.size >= VIEWING_MAX) break;
          if (typeof key === "string" && key !== "" && key.length <= KEY_MAX) next.add(key);
        }
      }
      current = next;
    },
    keys: () => current,
  };
}

/** Control characters out, then at most `max` characters. */
export function cleanOfficeText(text: string, max = OFFICE_QUESTION_MAX): string {
  let kept = "";
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) kept += char;
  }
  return kept.trim().slice(0, max);
}

const tabIdOf = (paneKey: string): string => paneKey.split(":")[0] ?? paneKey;

function entryOfView(view: AgentOf): OfficeEntry {
  const asking = view.prompt !== undefined || view.needsTerm === true;
  const state: OfficeState = asking ? "question" : view.working !== undefined ? "busy" : "idle";
  let doing: string | undefined;
  if (view.working !== undefined && view.working.trim() !== "")
    doing = cleanOfficeText(view.working);
  else {
    for (let at = view.turns.length - 1; at >= 0 && doing === undefined; at -= 1) {
      const tools = view.turns[at]?.tools ?? [];
      const tool = tools[tools.length - 1];
      if (tool !== undefined) {
        doing = cleanOfficeText(`${tool.name}${tool.target ? ` ${tool.target}` : ""}`);
      }
    }
  }
  return {
    agent: VENDOR_NAMES[view.vendor],
    state,
    ...(view.prompt === undefined ? {} : { question: cleanOfficeText(view.prompt.question) }),
    ...(doing === undefined || doing === "" ? {} : { doing }),
    ...(view.model === undefined ? {} : { model: view.model }),
  };
}

function entryOfSession(session: Session, vendor: string | undefined, log: string): OfficeEntry {
  const tail = stripAnsi(log).split("\n").slice(-TAIL_ROWS).join("\n");
  const prompt = readPrompt(tail);
  const input = readAgentInputState(tail, vendor ?? "");
  const state: OfficeState =
    prompt !== undefined || input === "approval-prompt"
      ? "question"
      : input === "busy"
        ? "busy"
        : "idle";
  const doing = cleanOfficeText(session.summary);
  return {
    state,
    ...(prompt === undefined ? {} : { question: cleanOfficeText(prompt.question) }),
    ...(doing === "" ? {} : { doing }),
    ...(session.model === undefined ? {} : { model: session.model }),
  };
}

function hasQuestion(activity: OfficeActivity | undefined): boolean {
  if (activity === undefined) return false;
  return [...Object.values(activity.panes), ...Object.values(activity.sessions)].some(
    (entry) => entry.state === "question",
  );
}

export function createOfficeActivity(deps: OfficeActivityDeps): OfficeWatcher {
  let latest: OfficeActivity | undefined;
  let signature = "";
  let lastScanAt = Number.NEGATIVE_INFINITY;
  let allDirty = false;
  const dirtyKeys = new Set<string>();
  /** When each pane last answered "no agent". */
  const noAgentAt = new Map<string, number>();
  let scanning: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  let stopped = false;
  const announcedAt = new Map<string, number>();
  const isDirty = (): boolean => allDirty || dirtyKeys.size > 0;

  function log(token: string): void {
    try {
      deps.log(`office: ${token}`);
    } catch {
      // A failing logger changes nothing.
    }
  }

  function arm(): void {
    if (stopped || cancelTimer !== undefined) return;
    const wait = Math.max(0, OFFICE_SCAN_MS - (deps.now() - lastScanAt));
    cancelTimer = deps.schedule(() => {
      cancelTimer = undefined;
      if (isDirty() || hasQuestion(latest)) void scan();
    }, wait);
  }

  async function collect(all: boolean, dirtyNow: ReadonlySet<string>): Promise<OfficeActivity> {
    const panes: Record<string, OfficeEntry> = {};
    const sessions: Record<string, OfficeEntry> = {};
    const now = deps.now();
    const livePanes = new Set<string>();
    for (const pane of deps.panes()) {
      if (pane.exited) continue;
      const key = pane.paneKey;
      livePanes.add(key);
      const previous = latest?.panes[key];
      const dirtyHere = all || dirtyNow.has(key);
      const noneAt = noAgentAt.get(key);
      let read: boolean;
      if (previous !== undefined) read = dirtyHere || previous.state === "question";
      else if (noneAt === undefined) read = true;
      else if (!dirtyHere) read = false;
      else if (now - noneAt >= OFFICE_NONE_MS) read = true;
      else {
        // Printed, but looked up too lately: try again once the wait is over.
        dirtyKeys.add(key);
        read = false;
      }
      if (!read) {
        if (previous !== undefined) panes[key] = previous;
        continue;
      }
      try {
        const view = await deps.agentView(key);
        if (view.kind === "agent") {
          panes[key] = entryOfView(view);
          noAgentAt.delete(key);
        } else noAgentAt.set(key, now);
      } catch {
        // A transient failure keeps what was known, and tries again.
        panes[key] = previous ?? { state: "unknown" };
        dirtyKeys.add(key);
        log("pane");
      }
    }
    for (const key of [...noAgentAt.keys()]) if (!livePanes.has(key)) noAgentAt.delete(key);
    for (const session of deps.sessions()) {
      if (session.origin === "external" || !LIVE.has(session.state)) continue;
      if (session.transcriptPath !== undefined) continue;
      const previous = latest?.sessions[session.id];
      if (
        previous !== undefined &&
        !all &&
        !dirtyNow.has(session.id) &&
        previous.state !== "question"
      ) {
        sessions[session.id] = previous;
        continue;
      }
      try {
        sessions[session.id] = entryOfSession(
          session,
          deps.vendorOf(session.agentId),
          deps.sessionLog(session.id),
        );
      } catch {
        sessions[session.id] = previous ?? { state: "unknown" };
        dirtyKeys.add(session.id);
        log("session");
      }
    }
    return { panes, sessions };
  }

  function announce(next: OfficeActivity): void {
    const now = deps.now();
    const raised: { key: string; target: string; entry: OfficeEntry; agentId?: string }[] = [];
    for (const [paneKey, entry] of Object.entries(next.panes)) {
      if (entry.state === "question" && latest?.panes[paneKey]?.state !== "question") {
        raised.push({ key: tabIdOf(paneKey), target: tabIdOf(paneKey), entry });
      }
    }
    for (const [id, entry] of Object.entries(next.sessions)) {
      if (entry.state === "question" && latest?.sessions[id]?.state !== "question") {
        raised.push({ key: id, target: id, entry });
      }
    }
    for (const { key, target, entry } of raised) {
      const last = announcedAt.get(key);
      if (last !== undefined && now - last < OFFICE_NOTIFY_COALESCE_MS) continue;
      if (deps.focused() && deps.viewing().has(target)) continue;
      announcedAt.set(key, now);
      const project = deps.projectOf(target) ?? MESSAGES.officeLounge(deps.language);
      try {
        deps.notify(
          MESSAGES.officeHandTitle(project, deps.language),
          entry.agent ?? MESSAGES.officeAnAgent(deps.language),
        );
      } catch {
        log("notify");
      }
    }
    // Targets no longer asking may be announced again at once only after the window.
    for (const [key, at] of announcedAt) {
      if (now - at >= OFFICE_NOTIFY_COALESCE_MS) announcedAt.delete(key);
    }
  }

  function scan(): Promise<void> {
    if (scanning !== undefined) return scanning;
    const all = allDirty;
    const dirtyNow = new Set(dirtyKeys);
    allDirty = false;
    dirtyKeys.clear();
    lastScanAt = deps.now();
    scanning = (async () => {
      try {
        const next = await collect(all, dirtyNow);
        announce(next);
        const nextSignature = JSON.stringify(next);
        latest = next;
        if (nextSignature !== signature) {
          signature = nextSignature;
          try {
            deps.emitChanged();
          } catch {
            log("emit");
          }
        }
      } catch {
        log("scan");
      } finally {
        scanning = undefined;
        if (isDirty() || hasQuestion(latest)) arm();
      }
    })();
    return scanning;
  }

  return {
    async read() {
      if (latest === undefined) await scan();
      else if (isDirty() && deps.now() - lastScanAt >= OFFICE_SCAN_MS) await scan();
      return latest ?? EMPTY_OFFICE_ACTIVITY;
    },
    markDirty(key) {
      if (key === undefined) allDirty = true;
      else if (dirtyKeys.size < DIRTY_MAX) dirtyKeys.add(key);
      else allDirty = true;
      arm();
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
