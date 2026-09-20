import type { Session, SessionOutput, Turn } from "@jarvis/core";
import type { ExpoPushMessage } from "@jarvis/remote";
import { MAX_PUSH_PROJECT_CHARS } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import {
  buildPushMessage,
  createNotifier,
  INITIAL_NOTIFY_STATE,
  NOTIFY_COALESCE_MS,
  NOTIFY_STATE_MAX,
  relevantChannels,
  shouldNotify,
  WAITING_QUIET_MS,
} from "./notify.js";
import type {
  NotifierDeps,
  NotifyContext,
  NotifyEvent,
  NotifyState,
  PushTarget,
} from "./notify.js";

// The one string that must never appear in a built message or a log line —
// standing in for a session's real transcript summary, which SessionManager
// carries around but this module must never touch.
const FORBIDDEN_SUMMARY = "the fixture's forbidden summary text";

const d1: PushTarget = {
  deviceId: "d1",
  token: "ExponentPushToken[d1tokenaaaaaaaa]",
  platform: "ios",
  language: "en",
};
const d2: PushTarget = {
  deviceId: "d2",
  token: "ExponentPushToken[d2tokenaaaaaaaa]",
  platform: "android",
  language: "ar",
};

function makeContext(overrides: Partial<NotifyContext> = {}): NotifyContext {
  return {
    enabled: true,
    includeProjectNames: false,
    focused: false,
    targets: [d1, d2],
    watching: () => new Set(),
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: null,
    projectPath: "/tmp/project",
    agentId: "claude",
    state: "running",
    summary: FORBIDDEN_SUMMARY,
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// relevantChannels
// ---------------------------------------------------------------------------

describe("relevantChannels", () => {
  it.each<[NotifyEvent, { channel: string; key?: string }[]]>([
    [
      { kind: "session-done", sessionId: "s1", project: null },
      [{ channel: "session:output", key: "s1" }, { channel: "sessions:update" }],
    ],
    [
      { kind: "session-failed", sessionId: "s1", project: null },
      [{ channel: "session:output", key: "s1" }, { channel: "sessions:update" }],
    ],
    [
      { kind: "session-waiting", sessionId: "s1", project: null },
      [{ channel: "session:output", key: "s1" }, { channel: "sessions:update" }],
    ],
    [
      { kind: "command-finished", paneKey: "p1", seconds: 10, ok: true },
      [{ channel: "terminal:data", key: "p1" }],
    ],
    [{ kind: "reply", replyTo: "t1" }, [{ channel: "turn:new" }]],
  ])("maps %j to %j", (event, expected) => {
    expect(relevantChannels(event)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// shouldNotify
// ---------------------------------------------------------------------------

describe("shouldNotify", () => {
  const doneEvent: NotifyEvent = { kind: "session-done", sessionId: "s1", project: null };

  it("sends nothing when disabled [bite-proof: drop the `!enabled` check]", () => {
    const result = shouldNotify(
      INITIAL_NOTIFY_STATE,
      makeContext({ enabled: false }),
      doneEvent,
      0,
    );
    expect(result.targets).toEqual([]);
  });

  it("sends nothing when focused", () => {
    const result = shouldNotify(INITIAL_NOTIFY_STATE, makeContext({ focused: true }), doneEvent, 0);
    expect(result.targets).toEqual([]);
  });

  it("skips a device watching the event's own session:output channel", () => {
    const ctx = makeContext({
      watching: (channel, key) =>
        channel === "session:output" && key === "s1" ? new Set(["d1"]) : new Set(),
    });
    const result = shouldNotify(INITIAL_NOTIFY_STATE, ctx, doneEvent, 0);
    expect(result.targets.map((t) => t.deviceId)).toEqual(["d2"]);
  });

  it("skips a device watching sessions:update for a session event", () => {
    const ctx = makeContext({
      watching: (channel) => (channel === "sessions:update" ? new Set(["d1"]) : new Set()),
    });
    const result = shouldNotify(INITIAL_NOTIFY_STATE, ctx, doneEvent, 0);
    expect(result.targets.map((t) => t.deviceId)).toEqual(["d2"]);
  });

  it("skips a device watching turn:new, for a reply event", () => {
    const ctx = makeContext({
      watching: (channel) => (channel === "turn:new" ? new Set(["d1"]) : new Set()),
    });
    const replyEvent: NotifyEvent = { kind: "reply", replyTo: "t1" };
    const result = shouldNotify(INITIAL_NOTIFY_STATE, ctx, replyEvent, 0);
    expect(result.targets.map((t) => t.deviceId)).toEqual(["d2"]);
  });

  it("coalesces a repeat of the same event inside NOTIFY_COALESCE_MS, and sends again once it elapses [bite-proof: `>=` instead of `>`]", () => {
    const ctx = makeContext();
    const first = shouldNotify(INITIAL_NOTIFY_STATE, ctx, doneEvent, 1_000);
    expect(first.targets).toHaveLength(2);

    const stillWithin = shouldNotify(first.state, ctx, doneEvent, 1_000 + NOTIFY_COALESCE_MS - 1);
    expect(stillWithin.targets).toEqual([]);

    const elapsed = shouldNotify(first.state, ctx, doneEvent, 1_000 + NOTIFY_COALESCE_MS);
    expect(elapsed.targets).toHaveLength(2);
  });

  it("does not coalesce a different sessionId", () => {
    const ctx = makeContext();
    const first = shouldNotify(INITIAL_NOTIFY_STATE, ctx, doneEvent, 1_000);
    const otherSession: NotifyEvent = { kind: "session-done", sessionId: "s2", project: null };
    const second = shouldNotify(first.state, ctx, otherSession, 1_001);
    expect(second.targets).toHaveLength(2);
  });

  it("never mutates the state object it's given", () => {
    const frozenState: NotifyState = Object.freeze({
      lastSent: new Map([["d1\u0000session-done\u0000s0", 0]]),
    });
    const before = new Map(frozenState.lastSent);
    shouldNotify(frozenState, makeContext(), doneEvent, 100_000);
    expect(frozenState.lastSent).toEqual(before);
  });

  it("caps state at NOTIFY_STATE_MAX entries for 600 distinct keys, evicting the oldest", () => {
    const ctx = makeContext({ targets: [d1] });
    let state: NotifyState = INITIAL_NOTIFY_STATE;
    for (let i = 0; i < 600; i++) {
      const event: NotifyEvent = { kind: "session-done", sessionId: `s${i}`, project: null };
      state = shouldNotify(state, ctx, event, i).state;
    }
    expect(state.lastSent.size).toBe(NOTIFY_STATE_MAX);
  });
});

// ---------------------------------------------------------------------------
// buildPushMessage
// ---------------------------------------------------------------------------

describe("buildPushMessage", () => {
  it("carries no project name when includeProjectNames is false", () => {
    const event: NotifyEvent = { kind: "session-done", sessionId: "s1", project: "acme-secret" };
    const message = buildPushMessage(d1, event, false);
    expect(JSON.stringify(message)).not.toContain("acme-secret");
  });

  it("carries the project name in body and data.project when includeProjectNames is true", () => {
    const event: NotifyEvent = { kind: "session-done", sessionId: "s1", project: "acme" };
    const message = buildPushMessage(d1, event, true);
    expect(message.body).toContain("acme");
    expect(message.data.project).toBe("acme");
  });

  it("truncates a 100-character project to MAX_PUSH_PROJECT_CHARS", () => {
    const longProject = "x".repeat(100);
    const event: NotifyEvent = { kind: "session-done", sessionId: "s1", project: longProject };
    const message = buildPushMessage(d1, event, true);
    expect((message.data.project as string).length).toBe(MAX_PUSH_PROJECT_CHARS);
  });

  it("carries exactly {kind} in command-finished's data", () => {
    const event: NotifyEvent = { kind: "command-finished", paneKey: "p1", seconds: 30, ok: true };
    const message = buildPushMessage(d1, event, true);
    expect(message.data).toEqual({ kind: "command-finished" });
  });

  it("carries exactly {kind} in reply's data", () => {
    const event: NotifyEvent = { kind: "reply", replyTo: "turn-1" };
    const message = buildPushMessage(d1, event, true);
    expect(message.data).toEqual({ kind: "reply" });
  });

  it("sets `to` to the target's token", () => {
    const event: NotifyEvent = { kind: "reply", replyTo: "turn-1" };
    const message = buildPushMessage(d1, event, false);
    expect(message.to).toBe(d1.token);
  });

  it("never contains the fixture's forbidden summary value [bite-proof: put it in the body]", () => {
    const event: NotifyEvent = { kind: "session-done", sessionId: "s1", project: "acme" };
    const message = buildPushMessage(d1, event, true);
    expect(JSON.stringify(message)).not.toContain(FORBIDDEN_SUMMARY);
  });
});

// ---------------------------------------------------------------------------
// createNotifier
// ---------------------------------------------------------------------------

type ScheduledTimer = { id: number; at: number; fn: () => void };

function fakeTimers(start = 0) {
  let time = start;
  let nextId = 1;
  const scheduled = new Map<number, ScheduledTimer>();

  const timers: NotifierDeps["timers"] = {
    setTimeout(fn, ms) {
      const id = nextId++;
      scheduled.set(id, { id, at: time + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number);
    },
  };

  function advance(ms: number): void {
    const target = time + ms;
    for (;;) {
      let due: ScheduledTimer | undefined;
      for (const candidate of scheduled.values()) {
        if (candidate.at > target) continue;
        if (
          due === undefined ||
          candidate.at < due.at ||
          (candidate.at === due.at && candidate.id < due.id)
        ) {
          due = candidate;
        }
      }
      if (due === undefined) break;
      scheduled.delete(due.id);
      time = due.at;
      due.fn();
    }
    time = target;
  }

  return { timers, now: () => time, advance, pending: () => scheduled.size };
}

function fakeSessions() {
  let changeListeners: ((list: Session[]) => void)[] = [];
  let outputListeners: ((output: SessionOutput) => void)[] = [];
  const byId = new Map<string, Session>();
  const logs = new Map<string, string>();

  const api: NotifierDeps["sessions"] = {
    onChange(listener) {
      changeListeners.push(listener);
      return () => {
        changeListeners = changeListeners.filter((l) => l !== listener);
      };
    },
    onOutput(listener) {
      outputListeners.push(listener);
      return () => {
        outputListeners = outputListeners.filter((l) => l !== listener);
      };
    },
    get(id) {
      return byId.get(id);
    },
    log(id) {
      return logs.get(id) ?? "";
    },
    list() {
      return [...byId.values()];
    },
  };

  function setState(next: Session): void {
    byId.set(next.id, next);
    for (const listener of [...changeListeners]) listener([...byId.values()]);
  }

  function setLog(id: string, text: string): void {
    logs.set(id, text);
  }

  function emitOutput(sessionId: string): void {
    for (const listener of [...outputListeners]) listener({ sessionId, chunk: "x", offset: 0 });
  }

  return { api, setState, setLog, emitOutput };
}

function fakeOnTurn() {
  let listeners: ((turn: Turn) => void)[] = [];
  return {
    subscribe(cb: (turn: Turn) => void): () => void {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    },
    fire(turn: Turn): void {
      for (const listener of [...listeners]) listener(turn);
    },
  };
}

function makeNotifier(contextOverrides: Partial<NotifyContext> = {}) {
  const sessionsFixture = fakeSessions();
  const timersFixture = fakeTimers();
  const turnFixture = fakeOnTurn();
  const sent: ExpoPushMessage[][] = [];
  const auditCalls: { deviceId: string; kind: string }[][] = [];
  const logLines: string[] = [];
  const ctx: NotifyContext = makeContext(contextOverrides);

  const notifier = createNotifier({
    sessions: sessionsFixture.api,
    onTurn: turnFixture.subscribe,
    context: () => ctx,
    send: (messages) => sent.push(messages),
    audit: (entries) => auditCalls.push([...entries]),
    now: timersFixture.now,
    timers: timersFixture.timers,
    log: (line) => logLines.push(line),
  });

  return { notifier, sessionsFixture, timersFixture, turnFixture, sent, auditCalls, logLines };
}

describe("createNotifier", () => {
  it("sends one message per target when a session moves running -> done", () => {
    const { notifier, sessionsFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    notifier.dispose();
  });

  it("sends session-failed when a session moves running -> dead with an exit code", () => {
    const { notifier, sessionsFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "dead", exitCode: 1 }));
    expect(sent).toHaveLength(1);
    notifier.dispose();
  });

  it("sends nothing when a session dies with no exit code (a manual kill) [bite-proof: treat every dead as failed]", () => {
    const { notifier, sessionsFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "dead" }));
    expect(sent).toHaveLength(0);
    notifier.dispose();
  });

  it("sends nothing for a session already done/dead the first time it's seen", () => {
    const { notifier, sessionsFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    expect(sent).toHaveLength(0);
    notifier.dispose();
  });

  it("emits session-waiting after WAITING_QUIET_MS of quiet output ending in a prompt", () => {
    const { notifier, sessionsFixture, timersFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setLog("s1", "Do you want to continue? (y/n)");
    sessionsFixture.emitOutput("s1");
    timersFixture.advance(WAITING_QUIET_MS);
    expect(sent).toHaveLength(1);
    notifier.dispose();
  });

  it("coalesces a second session-waiting inside NOTIFY_COALESCE_MS, sending again once it elapses", () => {
    const { notifier, sessionsFixture, timersFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setLog("s1", "(y/n)");

    sessionsFixture.emitOutput("s1");
    timersFixture.advance(WAITING_QUIET_MS);
    expect(sent).toHaveLength(1);

    sessionsFixture.emitOutput("s1");
    timersFixture.advance(WAITING_QUIET_MS);
    expect(sent).toHaveLength(1); // still inside the coalescing window

    timersFixture.advance(NOTIFY_COALESCE_MS);
    sessionsFixture.emitOutput("s1");
    timersFixture.advance(WAITING_QUIET_MS);
    expect(sent).toHaveLength(2);
    notifier.dispose();
  });

  it("emits nothing when the quiet tail doesn't look like a prompt", () => {
    const { notifier, sessionsFixture, timersFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setLog("s1", "just some ordinary output, nothing waiting here");
    sessionsFixture.emitOutput("s1");
    timersFixture.advance(WAITING_QUIET_MS);
    expect(sent).toHaveLength(0);
    notifier.dispose();
  });

  it("clears a session's armed quiet timer when it ends", () => {
    const { notifier, sessionsFixture, timersFixture } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setLog("s1", "(y/n)");
    sessionsFixture.emitOutput("s1");
    expect(timersFixture.pending()).toBeGreaterThan(0);
    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    expect(timersFixture.pending()).toBe(0);
    notifier.dispose();
  });

  it("emits reply for an assistant turn with replyTo", () => {
    const { notifier, turnFixture, sent } = makeNotifier();
    turnFixture.fire({ role: "assistant", text: "x", language: "en", at: 0, replyTo: "turn-1" });
    expect(sent).toHaveLength(1);
    notifier.dispose();
  });

  it("emits nothing for an assistant turn without replyTo", () => {
    const { notifier, turnFixture, sent } = makeNotifier();
    turnFixture.fire({ role: "assistant", text: "x", language: "en", at: 0 });
    expect(sent).toHaveLength(0);
    notifier.dispose();
  });

  it("emits nothing for a user turn, even with replyTo", () => {
    const { notifier, turnFixture, sent } = makeNotifier();
    turnFixture.fire({ role: "user", text: "x", language: "en", at: 0, replyTo: "turn-1" });
    expect(sent).toHaveLength(0);
    notifier.dispose();
  });

  it("never calls send when the context is disabled", () => {
    const { notifier, sessionsFixture, sent } = makeNotifier({ enabled: false });
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    expect(sent).toHaveLength(0);
    notifier.dispose();
  });

  it("dispose clears every timer and ignores later events", () => {
    const { notifier, sessionsFixture, timersFixture, turnFixture, sent } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setLog("s1", "(y/n)");
    sessionsFixture.emitOutput("s1");
    expect(timersFixture.pending()).toBeGreaterThan(0);

    notifier.dispose();
    expect(timersFixture.pending()).toBe(0);

    notifier.commandFinished("p1", 10, true);
    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    turnFixture.fire({ role: "assistant", text: "x", language: "en", at: 0, replyTo: "t1" });
    timersFixture.advance(WAITING_QUIET_MS);
    expect(sent).toHaveLength(0);
  });

  it("commandFinished emits a command-finished event with data exactly {kind}", () => {
    const { notifier, sent } = makeNotifier();
    notifier.commandFinished("p1", 90, false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]?.data).toEqual({ kind: "command-finished" });
    notifier.dispose();
  });

  // M12 Task 3, rule 7.
  it("audits the same device ids as the targets", () => {
    const { notifier, sessionsFixture, auditCalls } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "done" }));

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toEqual([
      { deviceId: "d1", kind: "session-done" },
      { deviceId: "d2", kind: "session-done" },
    ]);
    notifier.dispose();
  });

  // Fix round 1 (review minor): a shared call log, not two separate arrays
  // — proves the actual order, not just that both eventually ran.
  it('calls audit immediately before send, in that order [bite-proof: swap the two calls; the log reads ["send","audit"]]', () => {
    const sessionsFixture = fakeSessions();
    const timersFixture = fakeTimers();
    const turnFixture = fakeOnTurn();
    const calls: string[] = [];
    const ctx: NotifyContext = makeContext();
    const notifier = createNotifier({
      sessions: sessionsFixture.api,
      onTurn: turnFixture.subscribe,
      context: () => ctx,
      send: () => {
        calls.push("send");
      },
      audit: () => {
        calls.push("audit");
      },
      now: timersFixture.now,
      timers: timersFixture.timers,
      log: () => {},
    });

    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "done" }));

    expect(calls).toEqual(["audit", "send"]);
    notifier.dispose();
  });

  // [bite-proof: put `audit(...)` inside `send`'s own try, after the
  // `send(messages)` call (or otherwise made contingent on it) — a `send`
  // that throws before reaching `audit` then leaves `auditCalls` empty,
  // and this assertion fails.]
  it("still audits when send itself throws, proving audit runs independently of send", () => {
    const sessionsFixture = fakeSessions();
    const timersFixture = fakeTimers();
    const turnFixture = fakeOnTurn();
    const auditCalls: { deviceId: string; kind: string }[][] = [];
    const ctx: NotifyContext = makeContext();
    const notifier = createNotifier({
      sessions: sessionsFixture.api,
      onTurn: turnFixture.subscribe,
      context: () => ctx,
      send: () => {
        throw new Error("boom");
      },
      audit: (entries) => auditCalls.push([...entries]),
      now: timersFixture.now,
      timers: timersFixture.timers,
      log: () => {},
    });

    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "done" }));

    expect(auditCalls).toHaveLength(1);
    notifier.dispose();
  });

  it("a throwing audit still sends, and logs notify: audit threw", () => {
    const sessionsFixture = fakeSessions();
    const timersFixture = fakeTimers();
    const turnFixture = fakeOnTurn();
    const sent: ExpoPushMessage[][] = [];
    const logLines: string[] = [];
    const ctx: NotifyContext = makeContext();
    const notifier = createNotifier({
      sessions: sessionsFixture.api,
      onTurn: turnFixture.subscribe,
      context: () => ctx,
      send: (messages) => sent.push(messages),
      audit: () => {
        throw new Error("boom");
      },
      now: timersFixture.now,
      timers: timersFixture.timers,
      log: (line) => logLines.push(line),
    });

    expect(() => {
      sessionsFixture.setState(session({ id: "s1", state: "running" }));
      sessionsFixture.setState(session({ id: "s1", state: "done" }));
    }).not.toThrow();
    expect(sent).toHaveLength(1);
    expect(logLines).toContain("notify: audit threw");
    notifier.dispose();
  });

  // Deferred minor: `previous` is seeded from sessions.list() at creation,
  // not left empty — a session already "running" before the notifier
  // existed must still be diffed against on the first onChange, rather
  // than read as "already done the first time it's seen" and skipped.
  it("detects a transition to done for a session already running before the notifier was created", () => {
    const sessionsFixture = fakeSessions();
    // Set before createNotifier below — no listener is subscribed yet, so
    // this only seeds the fixture's own byId map, exactly like a session
    // still in flight from before a restart.
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    const timersFixture = fakeTimers();
    const turnFixture = fakeOnTurn();
    const sent: ExpoPushMessage[][] = [];
    const ctx: NotifyContext = makeContext();

    const notifier = createNotifier({
      sessions: sessionsFixture.api,
      onTurn: turnFixture.subscribe,
      context: () => ctx,
      send: (messages) => sent.push(messages),
      audit: () => {},
      now: timersFixture.now,
      timers: timersFixture.timers,
      log: () => {},
    });

    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    expect(sent).toHaveLength(1);
    notifier.dispose();
  });

  // Deferred minor: pins the exact log line shape, including the
  // enabled:false case, whose suppress word is "off".
  it("logs the exact `notify: <kind> targets=<n> suppressed=<word>` format", () => {
    const { notifier, sessionsFixture, logLines } = makeNotifier({ enabled: false });
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    expect(logLines).toContain("notify: session-done targets=0 suppressed=off");
    notifier.dispose();
  });

  it("logs suppressed=none once targets actually receive the push", () => {
    const { notifier, sessionsFixture, logLines } = makeNotifier();
    sessionsFixture.setState(session({ id: "s1", state: "running" }));
    sessionsFixture.setState(session({ id: "s1", state: "done" }));
    expect(logLines).toContain("notify: session-done targets=2 suppressed=none");
    notifier.dispose();
  });

  // Deferred minor: a throwing `send` must never escape the notifier.
  it("logs and swallows a throwing send rather than letting it escape", () => {
    const sessionsFixture = fakeSessions();
    const timersFixture = fakeTimers();
    const turnFixture = fakeOnTurn();
    const logLines: string[] = [];
    const ctx: NotifyContext = makeContext();
    const notifier = createNotifier({
      sessions: sessionsFixture.api,
      onTurn: turnFixture.subscribe,
      context: () => ctx,
      send: () => {
        throw new Error("boom");
      },
      audit: () => {},
      now: timersFixture.now,
      timers: timersFixture.timers,
      log: (line) => logLines.push(line),
    });

    expect(() => {
      sessionsFixture.setState(session({ id: "s1", state: "running" }));
      sessionsFixture.setState(session({ id: "s1", state: "done" }));
    }).not.toThrow();
    expect(logLines).toContain("notify: session-done send threw");
    notifier.dispose();
  });

  it("never logs the fixture's summary, project, command or token strings", () => {
    const { notifier, sessionsFixture, logLines } = makeNotifier({ includeProjectNames: true });
    sessionsFixture.setState(
      session({ id: "s1", state: "running", project: "top-secret-project" }),
    );
    sessionsFixture.setState(session({ id: "s1", state: "done", project: "top-secret-project" }));
    notifier.commandFinished("p1", 30, true);
    const joined = logLines.join("\n");
    expect(joined).not.toContain(FORBIDDEN_SUMMARY);
    expect(joined).not.toContain("top-secret-project");
    expect(joined).not.toContain("ExponentPushToken");
    expect(joined).not.toContain("p1");
    notifier.dispose();
  });
});
