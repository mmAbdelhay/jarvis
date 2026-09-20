// M10 Task 3: the push decision, the notifier and its five generic
// notification kinds. This is the one place that decides what text is
// allowed to leave the laptop as a push notification — every string comes
// from messages.ts's `pushTitle`/`pushBody`, whose only interpolated value
// is the project name (and only when `includeProjectNames` is true). Never
// a session summary, a command line, a path, a device name or a token.
//
// `shouldNotify` and `buildPushMessage` are pure — an injected clock, no
// timers, no I/O — so the coalescing and payload-shape rules are testable
// without a fake session manager at all. `createNotifier` is the only
// stateful piece: it watches `SessionManager`/`onTurn` for the events that
// can trigger a push, and owns exactly the timers behind the
// "waiting for you" quiet-period heuristic.
import { looksLikePrompt, PROMPT_TAIL_CHARS } from "@jarvis/core";
import type { Session, SessionManager, Turn } from "@jarvis/core";
import type { ExpoPushMessage } from "@jarvis/remote";
import { PUSH_TTL_SECONDS } from "@jarvis/remote";
import { MAX_PUSH_PROJECT_CHARS } from "@jarvis/wire";
import type { PushKind } from "@jarvis/wire";
import { MESSAGES } from "./messages.js";

/** How long a session's output must stay quiet, with a prompt-looking tail,
 *  before "session-waiting" fires. */
export const WAITING_QUIET_MS = 5_000;
/** The coalescing window: a repeat of the same (device, kind, key) push is
 *  suppressed inside this window (ruling: `shouldNotify` behaviour rule 2). */
export const NOTIFY_COALESCE_MS = 60_000;
/** The coalescing map's size cap — oldest entries evicted first. */
export const NOTIFY_STATE_MAX = 512;

export type NotifyEvent =
  | {
      kind: "session-done" | "session-failed" | "session-waiting";
      sessionId: string;
      project: string | null;
    }
  | { kind: "command-finished"; paneKey: string; seconds: number; ok: boolean }
  | { kind: "reply"; replyTo: string };

export type PushTarget = {
  deviceId: string;
  token: string;
  platform: "ios" | "android";
  language: "ar" | "en";
};

export type NotifyContext = {
  enabled: boolean;
  includeProjectNames: boolean;
  focused: boolean;
  targets: readonly PushTarget[];
  watching(channel: string, key?: string): ReadonlySet<string>;
};

export type NotifyState = { lastSent: ReadonlyMap<string, number> };
export const INITIAL_NOTIFY_STATE: NotifyState = { lastSent: new Map() };

/** `relevantChannels`' key for coalescing: the value a device's activity on
 *  the event's own channel(s) is checked against — a session id, a pane
 *  key, or "" for a reply (which has no per-target key of its own). */
function eventKeyOf(event: NotifyEvent): string {
  switch (event.kind) {
    case "session-done":
    case "session-failed":
    case "session-waiting":
      return event.sessionId;
    case "command-finished":
      return event.paneKey;
    case "reply":
      return "";
  }
}

/** The project name an event carries, or `null` for the two kinds that
 *  never have one. Truncation/gating on `includeProjectNames` happens in
 *  `buildPushMessage`, not here. */
function projectOf(event: NotifyEvent): string | null {
  switch (event.kind) {
    case "session-done":
    case "session-failed":
    case "session-waiting":
      return event.project;
    case "command-finished":
    case "reply":
      return null;
  }
}

/** `command-finished`'s own detail — never the command that ran, only a
 *  duration (rounded to minutes downstream, in messages.ts) and a boolean. */
function detailOf(event: NotifyEvent): { ok: boolean; seconds: number } | undefined {
  return event.kind === "command-finished" ? { ok: event.ok, seconds: event.seconds } : undefined;
}

function sessionIdOf(event: NotifyEvent): string | undefined {
  switch (event.kind) {
    case "session-done":
    case "session-failed":
    case "session-waiting":
      return event.sessionId;
    case "command-finished":
    case "reply":
      return undefined;
  }
}

/** The channels a device must be actively watching for this event to be
 *  suppressed instead of pushed — behaviour rule 1. */
export function relevantChannels(event: NotifyEvent): { channel: string; key?: string }[] {
  switch (event.kind) {
    case "session-done":
    case "session-failed":
    case "session-waiting":
      return [{ channel: "session:output", key: event.sessionId }, { channel: "sessions:update" }];
    case "command-finished":
      return [{ channel: "terminal:data", key: event.paneKey }];
    case "reply":
      return [{ channel: "turn:new" }];
  }
}

function watchingDevicesFor(context: NotifyContext, event: NotifyEvent): Set<string> {
  const result = new Set<string>();
  for (const { channel, key } of relevantChannels(event)) {
    for (const deviceId of context.watching(channel, key)) result.add(deviceId);
  }
  return result;
}

/**
 * The pure push decision (behaviour rule 2): nothing when `!enabled` or
 * `focused`; per target, nothing when that device is watching a relevant
 * channel or was already sent this exact (device, kind, key) within
 * NOTIFY_COALESCE_MS. Never mutates `state` or `context` — every returned
 * state is a fresh value, capped at NOTIFY_STATE_MAX entries (oldest by
 * recorded time evicted first).
 */
export function shouldNotify(
  state: NotifyState,
  context: NotifyContext,
  event: NotifyEvent,
  now: number,
): { targets: PushTarget[]; state: NotifyState } {
  if (!context.enabled) return { targets: [], state };
  if (context.focused) return { targets: [], state };

  const watchingDevices = watchingDevicesFor(context, event);
  const key = eventKeyOf(event);
  const targets: PushTarget[] = [];
  const nextEntries = new Map(state.lastSent);
  let grew = false;

  for (const target of context.targets) {
    if (watchingDevices.has(target.deviceId)) continue;
    const stateKey = `${target.deviceId}\u0000${event.kind}\u0000${key}`;
    const last = nextEntries.get(stateKey);
    if (last !== undefined && last > now - NOTIFY_COALESCE_MS) continue;
    targets.push(target);
    nextEntries.set(stateKey, now);
    grew = true;
  }

  if (!grew) return { targets, state };

  let finalEntries = nextEntries;
  if (finalEntries.size > NOTIFY_STATE_MAX) {
    const sortedOldestFirst = [...finalEntries.entries()].sort((a, b) => a[1] - b[1]);
    finalEntries = new Map(sortedOldestFirst.slice(sortedOldestFirst.length - NOTIFY_STATE_MAX));
  }

  return { targets, state: { lastSent: finalEntries } };
}

/**
 * The payload for one target — behaviour rule 3. `project` reaches the
 * message only when `includeProjectNames` is true and the event carries
 * one, truncated to MAX_PUSH_PROJECT_CHARS; `data` never carries anything
 * else beyond `kind`, a validated `sessionId` (session-* kinds only) and
 * that same `project`.
 */
export function buildPushMessage(
  target: PushTarget,
  event: NotifyEvent,
  includeProjectNames: boolean,
): ExpoPushMessage {
  const rawProject = projectOf(event);
  const project =
    includeProjectNames && rawProject ? rawProject.slice(0, MAX_PUSH_PROJECT_CHARS) : undefined;
  const detail = detailOf(event);
  const sessionId = sessionIdOf(event);

  const data: Record<string, string> = { kind: event.kind };
  if (sessionId !== undefined) data.sessionId = sessionId;
  if (project !== undefined) data.project = project;

  return {
    to: target.token,
    title: MESSAGES.pushTitle(target.language),
    body: MESSAGES.pushBody(event.kind, project, target.language, detail),
    data,
    sound: "default",
    priority: "high",
    channelId: "jarvis",
    ttl: PUSH_TTL_SECONDS,
  };
}

export type NotifierDeps = {
  sessions: Pick<SessionManager, "onChange" | "onOutput" | "get" | "log" | "list">;
  onTurn(cb: (turn: Turn) => void): () => void;
  context(): NotifyContext;
  send(messages: ExpoPushMessage[]): void;
  /** M12 Task 3, rule 7: called with the same device ids `send` is about to
   *  reach — never a token, a title, a body or a project. */
  audit(entries: readonly { deviceId: string; kind: PushKind }[]): void;
  now(): number;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  log(line: string): void;
};

export type Notifier = {
  commandFinished(paneKey: string, seconds: number, ok: boolean): void;
  dispose(): void;
};

/** Logging's `suppressed=` word (behaviour rule 6) — counts and category
 *  only, never a reason that could carry a project name or similar. */
function suppressReason(
  context: NotifyContext,
  event: NotifyEvent,
  sentTargets: readonly PushTarget[],
): "off" | "focused" | "watching" | "coalesced" | "none" {
  if (!context.enabled) return "off";
  if (context.focused) return "focused";
  if (sentTargets.length > 0) return "none";
  if (context.targets.length === 0) return "none";
  const watchingDevices = watchingDevicesFor(context, event);
  const allWatching = context.targets.every((target) => watchingDevices.has(target.deviceId));
  return allWatching ? "watching" : "coalesced";
}

/**
 * Wires SessionManager/onTurn/commandFinished into `shouldNotify` +
 * `buildPushMessage` + `deps.send` (behaviour rules 4-7). Every timer this
 * function arms goes through `deps.timers`, so `dispose()` — and a
 * session's own end — can clear it without a real clock.
 */
export function createNotifier(deps: NotifierDeps): Notifier {
  const { sessions, onTurn, context, send, audit, now, timers, log } = deps;

  let state: NotifyState = INITIAL_NOTIFY_STATE;
  let disposed = false;

  // Previous session-list snapshot, by id, for diffing state transitions on
  // the next onChange call. Seeded from the live list at creation — not
  // left empty — so a session already "running" before this notifier
  // existed (e.g. one still in flight from before a restart) is correctly
  // diffed against on the very first onChange, rather than read as "seen
  // for the first time already done" and silently skipped. Only `state` is
  // kept — an earlier `exitCode` field here was never read back (the
  // session-failed check below reads the *current* session's `exitCode`,
  // never a previous one) — deferred M10 Task 3 minor, dropped here.
  let previous = new Map<string, Pick<Session, "state">>(
    sessions.list().map((s) => [s.id, { state: s.state }]),
  );

  // One quiet timer per session with output pending "waiting" evaluation,
  // and one "already flagged this quiet episode" marker per session — both
  // cleared the instant a session ends (behaviour rule 4).
  const quietTimers = new Map<string, unknown>();
  const waitingFlagged = new Set<string>();

  function clearQuiet(id: string): void {
    const handle = quietTimers.get(id);
    if (handle === undefined) return;
    timers.clearTimeout(handle);
    quietTimers.delete(id);
  }

  function armQuiet(id: string): void {
    clearQuiet(id);
    const handle = timers.setTimeout(() => {
      quietTimers.delete(id);
      const session = sessions.get(id);
      if (session === undefined || session.state !== "running") return;
      const tail = sessions.log(id).slice(-PROMPT_TAIL_CHARS);
      if (!looksLikePrompt(tail)) return;
      if (waitingFlagged.has(id)) return;
      waitingFlagged.add(id);
      emit({ kind: "session-waiting", sessionId: id, project: session.project });
    }, WAITING_QUIET_MS);
    quietTimers.set(id, handle);
  }

  function emit(event: NotifyEvent): void {
    if (disposed) return;
    const ctx = context();
    const result = shouldNotify(state, ctx, event, now());
    state = result.state;
    const reason = suppressReason(ctx, event, result.targets);
    log(`notify: ${event.kind} targets=${result.targets.length} suppressed=${reason}`);
    if (result.targets.length === 0) return;
    const messages = result.targets.map((target) =>
      buildPushMessage(target, event, ctx.includeProjectNames),
    );
    // Rule 7: audited immediately before send, in its own try/catch — a
    // throwing audit must never stop the push itself from going out.
    try {
      audit(result.targets.map((target) => ({ deviceId: target.deviceId, kind: event.kind })));
    } catch {
      log("notify: audit threw");
    }
    try {
      send(messages);
    } catch {
      log(`notify: ${event.kind} send threw`);
    }
  }

  const unsubscribeChange = sessions.onChange((list) => {
    if (disposed) return;
    const current = new Map(list.map((session) => [session.id, session]));
    for (const [id, session] of current) {
      const prevEntry = previous.get(id);
      if (prevEntry !== undefined && prevEntry.state !== session.state) {
        if (session.state === "done") {
          emit({ kind: "session-done", sessionId: id, project: session.project });
        } else if (session.state === "dead" && session.exitCode !== undefined) {
          emit({ kind: "session-failed", sessionId: id, project: session.project });
        }
        // A transition to "dead" with no exitCode (a manual kill) — nothing.
      }
      // A session seen for the first time already done/dead (prevEntry
      // undefined) — nothing, deliberately: this is not a transition.
      if (session.state === "done" || session.state === "dead") {
        clearQuiet(id);
        waitingFlagged.delete(id);
      }
    }
    previous = new Map([...current].map(([id, session]) => [id, { state: session.state }]));
  });

  const unsubscribeOutput = sessions.onOutput(({ sessionId }) => {
    if (disposed) return;
    waitingFlagged.delete(sessionId);
    armQuiet(sessionId);
  });

  const unsubscribeTurn = onTurn((turn) => {
    if (disposed) return;
    if (turn.role === "assistant" && turn.replyTo !== undefined) {
      emit({ kind: "reply", replyTo: turn.replyTo });
    }
  });

  function commandFinished(paneKey: string, seconds: number, ok: boolean): void {
    if (disposed) return;
    emit({ kind: "command-finished", paneKey, seconds, ok });
  }

  function dispose(): void {
    disposed = true;
    unsubscribeChange();
    unsubscribeOutput();
    unsubscribeTurn();
    for (const handle of quietTimers.values()) timers.clearTimeout(handle);
    quietTimers.clear();
    waitingFlagged.clear();
  }

  return { commandFinished, dispose };
}
