import { beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator, TOOL_NAMES } from "./orchestrator.js";
import type { Brain, BrainReply } from "./types.js";
import { AgentRegistry } from "../registry/registry.js";
import { SessionManager } from "../session/manager.js";
import type { ProcessHandle, Session } from "../session/types.js";
import type { GitProvider } from "../git/types.js";
import type { SessionChanges } from "../git/tracker.js";
import type { ProviderStatus } from "../providers/types.js";

function fakeGitProvider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    changes: async (repoPath) => ({
      ok: true,
      value: {
        repoPath,
        branch: "feat/checkout-retry",
        detached: false,
        files: [{ path: "a.php", status: "M", insertions: 3, deletions: 1, staged: false }],
        insertions: 3,
        deletions: 1,
      },
    }),
    diff: async (_repoPath, filePath) => ({
      ok: true,
      value: { path: filePath, binary: false, hunks: [] },
    }),
    stage: async () => ({ ok: true, value: null }),
    unstage: async () => ({ ok: true, value: null }),
    commit: async () => ({ ok: true, value: { sha: "a1b2c3d", filesChanged: 1 } }),
    ...overrides,
  };
}

const registry = new AgentRegistry({
  agents: {
    "claude-main": { command: "claude-main", model: "opus", default: true },
    "claude-acme": { command: "claude-acme", model: "sonnet" },
  },
  routing: [{ match: { project: "acme" }, agent: "claude-acme" }],
});

function fakeProcess(): ProcessHandle {
  return {
    write: () => {},
    kill: () => {},
    onOutput: () => {},
    onExit: () => {},
  };
}

function brainReturning(reply: BrainReply): Brain {
  return { ask: async () => reply };
}

describe("Orchestrator", () => {
  let sessions: SessionManager;
  let speak: ReturnType<typeof vi.fn<(text: string, language: "ar" | "en") => Promise<void>>>;

  beforeEach(() => {
    sessions = new SessionManager(() => fakeProcess());
    speak = vi.fn(async () => {});
  });

  const build = (brain: Brain) =>
    new Orchestrator({
      brain,
      registry,
      sessions,
      git: fakeGitProvider(),
      changes: () => [],
      speak,
      projects: { acme: "/Users/x/projects/acme" },
      providers: { snapshot: () => [], refresh: async () => {} },
    });

  it("records the user turn before answering", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await orchestrator.handle("run the tests", "en");
    expect(orchestrator.transcript()[0]).toMatchObject({ role: "user", text: "run the tests" });
  });

  it("returns the assistant turn with the reply text", async () => {
    const orchestrator = build(brainReturning({ text: "Started.", toolCalls: [] }));
    const turn = await orchestrator.handle("run the tests", "en");
    expect(turn).toMatchObject({ role: "assistant", text: "Started." });
  });

  it("speaks the reply in the language the user used", async () => {
    const orchestrator = build(brainReturning({ text: "تمام", toolCalls: [] }));
    await orchestrator.handle("شغل الاختبارات", "ar");
    expect(speak).toHaveBeenCalledWith("تمام", "ar");
  });

  // Ruling 5: muting is per turn, not a global flag — a phone turn stays
  // quiet on the laptop, but its transcript entries are unaffected.
  // [bite-proof: ignore the option; speak is called regardless]
  it("does not speak when speakAloud is false, but still records both turns", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await orchestrator.handle("hi", "en", { speakAloud: false });
    expect(speak).not.toHaveBeenCalled();
    expect(orchestrator.transcript()).toMatchObject([
      { role: "user", text: "hi" },
      { role: "assistant", text: "ok" },
    ]);
  });

  it("still speaks when no options are given", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await orchestrator.handle("hi", "en");
    expect(speak).toHaveBeenCalledWith("ok", "en");
  });

  it("carries replyTo on both the user and the assistant turn when given", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await orchestrator.handle("hi", "en", { replyTo: "ab12" });
    const [user, assistant] = orchestrator.transcript();
    expect(user?.replyTo).toBe("ab12");
    expect(assistant?.replyTo).toBe("ab12");
  });

  it("leaves replyTo absent (not undefined-valued) when none is given", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await orchestrator.handle("hi", "en");
    const [user, assistant] = orchestrator.transcript();
    expect(Object.hasOwn(user ?? {}, "replyTo")).toBe(false);
    expect(Object.hasOwn(assistant ?? {}, "replyTo")).toBe(false);
  });

  it("mutes and carries replyTo on the brain-failure turn too", async () => {
    const orchestrator = build({
      ask: async () => {
        throw new Error("rate limited");
      },
    });
    const turn = await orchestrator.handle("hi", "en", { speakAloud: false, replyTo: "cd34" });
    expect(speak).not.toHaveBeenCalled();
    expect(turn.replyTo).toBe("cd34");
    expect(turn.text).toContain("rate limited");
  });

  it("starts a session when the brain calls session.start", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "acme" } }],
      }),
    );
    const turn = await orchestrator.handle("افتح متجر أكمي", "ar");
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]?.agentId).toBe("claude-acme");
    expect(turn.sessionId).toBe(sessions.list()[0]?.id);
    expect(turn.agentId).toBe("claude-acme");
  });

  // The whole point of "start a session in acme and fetch my bugs": the
  // brain has one turn, and the session id it would need for session.send
  // does not exist until session.start has already run. Without `task` the
  // request loses everything after "start a session".
  it("types the task into the session it just started", async () => {
    const written: string[] = [];
    sessions = new SessionManager(() => ({
      ...fakeProcess(),
      write: (data: string) => written.push(data),
      onOutput: (listener: (chunk: string) => void) => listener("banner"),
    }));
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [
          {
            name: "session.start",
            input: { project: "acme", task: "fetch the bugs assigned to me" },
          },
        ],
      }),
    );

    await orchestrator.handle("open acme and fetch my bugs", "en");
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(written).toEqual(["fetch the bugs assigned to me\r"]);
  });

  it("starts the session normally when no task is given", async () => {
    const written: string[] = [];
    sessions = new SessionManager(() => ({
      ...fakeProcess(),
      write: (data: string) => written.push(data),
      onOutput: (listener: (chunk: string) => void) => listener("banner"),
    }));
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "acme" } }],
      }),
    );

    await orchestrator.handle("open acme", "en");
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(written).toEqual([]);
  });

  it("declares the task in the session.start tool schema", async () => {
    let seen: readonly { name: string; inputSchema: Record<string, string> }[] = [];
    const orchestrator = build({
      ask: async ({ tools }) => {
        seen = tools as typeof seen;
        return { text: "ok", toolCalls: [] };
      },
    });

    await orchestrator.handle("hello", "en");

    const start = seen.find((tool) => tool.name === "session.start");
    expect(Object.keys(start?.inputSchema ?? {})).toContain("task");
  });

  it("honours an explicit agent in the tool call", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Using mm.",
        toolCalls: [{ name: "session.start", input: { project: "acme", agent: "claude-main" } }],
      }),
    );
    await orchestrator.handle("use my main account", "en");
    expect(sessions.list()[0]?.agentId).toBe("claude-main");
  });

  it("reports an unknown project without throwing", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "nope" } }],
      }),
    );
    const turn = await orchestrator.handle("open nope", "en");
    expect(sessions.list()).toHaveLength(0);
    expect(turn.text).toContain("nope");
  });

  it("reports a brain failure as a spoken turn instead of throwing", async () => {
    const orchestrator = build({
      ask: async () => {
        throw new Error("rate limited");
      },
    });
    const turn = await orchestrator.handle("hello", "en");
    expect(turn.role).toBe("assistant");
    expect(turn.text).toContain("rate limited");
    expect(speak).toHaveBeenCalled();
  });

  it("reports an unknown explicit agent without throwing", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "acme", agent: "nope" } }],
      }),
    );
    const turn = await orchestrator.handle("open with nope", "en");
    expect(sessions.list()).toHaveLength(0);
    expect(turn.text).toContain("nope");
  });

  it("reports an unrecognised tool call instead of silently doing nothing", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Sent.",
        toolCalls: [{ name: "session.pause", input: { sessionId: "abc" } }],
      }),
    );
    const turn = await orchestrator.handle("pause it", "en");
    expect(sessions.list()).toHaveLength(0);
    expect(turn.sessionId).toBeUndefined();
    expect(turn.text).toContain("session.pause");
    expect(turn.text).not.toBe("Sent.");
  });

  it("sends text to a running session via session.send", async () => {
    const agent = registry.resolve({ project: "acme" });
    const started = sessions.start({ project: "acme", projectPath: "/x", agent });
    const spy = vi.spyOn(sessions, "send");
    const orchestrator = build(
      brainReturning({
        text: "Sent.",
        toolCalls: [{ name: "session.send", input: { sessionId: started.id, text: "go" } }],
      }),
    );
    const turn = await orchestrator.handle("send go", "en");
    expect(spy).toHaveBeenCalledWith(started.id, "go");
    expect(turn.text).toBe("Sent.");
  });

  it("reports an unknown session for session.send", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Sent.",
        toolCalls: [{ name: "session.send", input: { sessionId: "missing", text: "go" } }],
      }),
    );
    const turn = await orchestrator.handle("send go", "en");
    expect(turn.text).toContain("missing");
  });

  it("kills a running session via session.kill", async () => {
    const agent = registry.resolve({ project: "acme" });
    const started = sessions.start({ project: "acme", projectPath: "/x", agent });
    const orchestrator = build(
      brainReturning({
        text: "Stopped.",
        toolCalls: [{ name: "session.kill", input: { sessionId: started.id } }],
      }),
    );
    const turn = await orchestrator.handle("stop it", "en");
    expect(sessions.get(started.id)?.state).toBe("dead");
    expect(turn.text).toBe("Stopped.");
  });

  it("reports an unknown session for session.kill", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Stopped.",
        toolCalls: [{ name: "session.kill", input: { sessionId: "missing" } }],
      }),
    );
    const turn = await orchestrator.handle("stop it", "en");
    expect(turn.text).toContain("missing");
  });

  it("reports a failed session start as a spoken turn instead of throwing", async () => {
    const throwingSessions = new SessionManager(() => {
      throw new Error("spawn ENOENT");
    });
    const orchestrator = new Orchestrator({
      brain: brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "acme" } }],
      }),
      registry,
      sessions: throwingSessions,
      git: fakeGitProvider(),
      changes: () => [],
      speak,
      projects: { acme: "/Users/x/projects/acme" },
      providers: { snapshot: () => [], refresh: async () => {} },
    });
    const turn = await orchestrator.handle("open acme", "en");
    expect(turn.role).toBe("assistant");
    expect(turn.text).toContain("spawn ENOENT");
    expect(speak).toHaveBeenCalled();
  });

  it("produces Arabic failure text for an Arabic turn", async () => {
    const orchestrator = build(
      brainReturning({
        text: "جاري البدء.",
        toolCalls: [{ name: "session.start", input: { project: "nope" } }],
      }),
    );
    const turn = await orchestrator.handle("افتح nope", "ar");
    expect(turn.text).toContain("لا أعرف مشروعًا");
    expect(speak).toHaveBeenCalledWith(turn.text, "ar");
  });

  it("starts two sessions from two tool calls in one reply", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Starting both.",
        toolCalls: [
          { name: "session.start", input: { project: "acme" } },
          { name: "session.start", input: { project: "acme", agent: "claude-main" } },
        ],
      }),
    );
    const turn = await orchestrator.handle("open both", "en");
    expect(sessions.list()).toHaveLength(2);
    const second = sessions.list()[1];
    expect(turn.sessionId).toBe(second?.id);
    expect(turn.agentId).toBe("claude-main");
  });

  it("keeps a successful tool call's result when a later call in the same reply fails", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Mixed.",
        toolCalls: [
          { name: "session.start", input: { project: "acme" } },
          { name: "session.start", input: { project: "nope" } },
        ],
      }),
    );
    const turn = await orchestrator.handle("open both", "en");
    expect(sessions.list()).toHaveLength(1);
    expect(turn.sessionId).toBe(sessions.list()[0]?.id);
    expect(turn.text).toContain("nope");
  });

  it("does not let a speak failure reject handle()", async () => {
    speak.mockRejectedValueOnce(new Error("tts down"));
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await expect(orchestrator.handle("hi", "en")).resolves.toMatchObject({
      role: "assistant",
      text: "ok",
    });
  });

  it("isolates a throwing listener from other listeners and from the turn", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    orchestrator.onTurn(bad);
    orchestrator.onTurn(good);
    await expect(orchestrator.handle("hi", "en")).resolves.toMatchObject({ role: "assistant" });
    expect(good).toHaveBeenCalledTimes(2);
  });

  it("handles a reply with no toolCalls array", async () => {
    const orchestrator = build({ ask: async () => JSON.parse('{"text":"ok"}') });
    const turn = await orchestrator.handle("hi", "en");
    expect(turn.text).toBe("ok");
  });

  it("trims the spoken text when the reply text is empty", async () => {
    const orchestrator = build(
      brainReturning({
        text: "",
        toolCalls: [{ name: "session.start", input: { project: "nope" } }],
      }),
    );
    const turn = await orchestrator.handle("open nope", "en");
    expect(turn.text).toBe('I don\'t know a project called "nope".');
  });

  it("includes the model in the assistant turn when the agent has one", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "acme" } }],
      }),
    );
    const turn = await orchestrator.handle("open acme", "en");
    expect(turn.model).toBe("sonnet");
  });

  it("appends the tool error note to the reply text", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "nope" } }],
      }),
    );
    const turn = await orchestrator.handle("open nope", "en");
    expect(turn.text).toBe('Starting. I don\'t know a project called "nope".');
  });

  it("unsubscribes a listener once the returned function is called", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    const other = vi.fn();
    const listener = vi.fn();
    orchestrator.onTurn(other);
    const unsubscribe = orchestrator.onTurn(listener);
    unsubscribe();
    await orchestrator.handle("hi", "en");
    expect(listener).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers for both turns", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    const listener = vi.fn();
    orchestrator.onTurn(listener);
    await orchestrator.handle("hi", "en");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reports an unrecognised tool call in Arabic", async () => {
    const orchestrator = build(
      brainReturning({
        text: "جاري.",
        toolCalls: [{ name: "session.pause", input: {} }],
      }),
    );
    const turn = await orchestrator.handle("أوقفها مؤقتًا", "ar");
    expect(turn.text).toContain("لا أعرف كيف أفعل ذلك");
    expect(speak).toHaveBeenCalledWith(turn.text, "ar");
  });

  it("reports an unknown session for session.send in Arabic", async () => {
    const orchestrator = build(
      brainReturning({
        text: "جاري الإرسال.",
        toolCalls: [{ name: "session.send", input: { sessionId: "missing", text: "go" } }],
      }),
    );
    const turn = await orchestrator.handle("أرسل", "ar");
    expect(turn.text).toContain("لا أعرف جلسة باسم");
    expect(speak).toHaveBeenCalledWith(turn.text, "ar");
  });

  it("reports a failed session start in Arabic", async () => {
    const throwingSessions = new SessionManager(() => {
      throw new Error("spawn ENOENT");
    });
    const orchestrator = new Orchestrator({
      brain: brainReturning({
        text: "جاري البدء.",
        toolCalls: [{ name: "session.start", input: { project: "acme" } }],
      }),
      registry,
      sessions: throwingSessions,
      git: fakeGitProvider(),
      changes: () => [],
      speak,
      projects: { acme: "/Users/x/projects/acme" },
      providers: { snapshot: () => [], refresh: async () => {} },
    });
    const turn = await orchestrator.handle("افتح متجر أكمي", "ar");
    expect(turn.text).toContain("تعذر بدء الجلسة");
    expect(speak).toHaveBeenCalledWith(turn.text, "ar");
  });

  it("reports a brain failure in Arabic", async () => {
    const orchestrator = build({
      ask: async () => {
        throw new Error("rate limited");
      },
    });
    const turn = await orchestrator.handle("مرحبا", "ar");
    expect(turn.text).toContain("حدث خطأ");
    expect(speak).toHaveBeenCalledWith(turn.text, "ar");
  });

  it("collects notes from two failing tool calls", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Both failed.",
        toolCalls: [
          { name: "session.start", input: { project: "nope" } },
          { name: "session.send", input: { sessionId: "missing", text: "go" } },
        ],
      }),
    );
    const turn = await orchestrator.handle("do both", "en");
    expect(turn.text).toContain("nope");
    expect(turn.text).toContain("missing");
  });

  it("still runs a later successful call when an earlier call fails", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Mixed.",
        toolCalls: [
          { name: "session.start", input: { project: "nope" } },
          { name: "session.start", input: { project: "acme" } },
        ],
      }),
    );
    const turn = await orchestrator.handle("open both", "en");
    expect(sessions.list()).toHaveLength(1);
    expect(turn.sessionId).toBe(sessions.list()[0]?.id);
    expect(turn.text).toContain("nope");
  });

  it("reports a distinct failure when session.send fails for a reason other than an unknown id", async () => {
    const agent = registry.resolve({ project: "acme" });
    const started = sessions.start({ project: "acme", projectPath: "/x", agent });
    vi.spyOn(sessions, "send").mockImplementation(() => {
      throw new Error("write EPIPE");
    });
    const orchestrator = build(
      brainReturning({
        text: "Sent.",
        toolCalls: [{ name: "session.send", input: { sessionId: started.id, text: "go" } }],
      }),
    );
    const turn = await orchestrator.handle("send go", "en");
    expect(turn.text).not.toContain("I don't know a session called");
    expect(turn.text).toContain("write EPIPE");
  });

  it("reports a distinct failure when session.kill fails for a reason other than an unknown id", async () => {
    const agent = registry.resolve({ project: "acme" });
    const started = sessions.start({ project: "acme", projectPath: "/x", agent });
    vi.spyOn(sessions, "kill").mockImplementation(() => {
      throw new Error("process already exited");
    });
    const orchestrator = build(
      brainReturning({
        text: "Stopped.",
        toolCalls: [{ name: "session.kill", input: { sessionId: started.id } }],
      }),
    );
    const turn = await orchestrator.handle("stop it", "en");
    expect(turn.text).not.toContain("I don't know a session called");
    expect(turn.text).toContain("process already exited");
  });

  it("includes the session id in the returned context for session.send", async () => {
    const agent = registry.resolve({ project: "acme" });
    const started = sessions.start({ project: "acme", projectPath: "/x", agent });
    const orchestrator = build(
      brainReturning({
        text: "Sent.",
        toolCalls: [{ name: "session.send", input: { sessionId: started.id, text: "go" } }],
      }),
    );
    const turn = await orchestrator.handle("send go", "en");
    expect(turn.sessionId).toBe(started.id);
  });

  it("includes the session id in the returned context for session.kill", async () => {
    const agent = registry.resolve({ project: "acme" });
    const started = sessions.start({ project: "acme", projectPath: "/x", agent });
    const orchestrator = build(
      brainReturning({
        text: "Stopped.",
        toolCalls: [{ name: "session.kill", input: { sessionId: started.id } }],
      }),
    );
    const turn = await orchestrator.handle("stop it", "en");
    expect(turn.sessionId).toBe(started.id);
  });

  it("does not let a stale model outlive its session across two session.start calls", async () => {
    const localRegistry = new AgentRegistry({
      agents: {
        "claude-main": { command: "claude-main", model: "opus", default: true },
        "claude-plain": { command: "claude-plain" },
      },
    });
    const orchestrator = new Orchestrator({
      brain: brainReturning({
        text: "Starting both.",
        toolCalls: [
          { name: "session.start", input: { project: "a", agent: "claude-main" } },
          { name: "session.start", input: { project: "a", agent: "claude-plain" } },
        ],
      }),
      registry: localRegistry,
      sessions,
      git: fakeGitProvider(),
      changes: () => [],
      speak,
      projects: { a: "/Users/x/projects/a" },
      providers: { snapshot: () => [], refresh: async () => {} },
    });
    const turn = await orchestrator.handle("open both", "en");
    const second = sessions.list()[1];
    expect(turn.sessionId).toBe(second?.id);
    expect(turn.agentId).toBe("claude-plain");
    expect(turn.model).toBeUndefined();
  });

  it("does not disturb the listener loop when a listener unsubscribes itself during dispatch", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    const other = vi.fn();
    let unsubscribeSelf: () => void = () => {};
    const selfUnsubscribing = vi.fn(() => {
      unsubscribeSelf();
    });
    unsubscribeSelf = orchestrator.onTurn(selfUnsubscribing);
    orchestrator.onTurn(other);
    await orchestrator.handle("hi", "en");
    expect(selfUnsubscribing).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("keeps the transcript across turns", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await orchestrator.handle("one", "en");
    await orchestrator.handle("two", "en");
    expect(orchestrator.transcript()).toHaveLength(4);
  });

  // --- Critical 1/2: the brain must see project names, tool schemas, and
  // running sessions, not just tool name/description strings.
  describe("brain context", () => {
    it("passes the known project names to the brain", async () => {
      const ask = vi.fn<Brain["ask"]>(async () => ({ text: "ok", toolCalls: [] }));
      const orchestrator = build({ ask });
      await orchestrator.handle("افتح متجر أكمي", "ar");
      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.objectContaining({ projects: ["acme"] }) }),
      );
    });

    it("passes every tool's input schema to the brain", async () => {
      const ask = vi.fn<Brain["ask"]>(async () => ({ text: "ok", toolCalls: [] }));
      const orchestrator = build({ ask });
      await orchestrator.handle("hi", "en");
      const call = ask.mock.calls[0]?.[0];
      const startTool = call?.tools.find((tool) => tool.name === "session.start");
      expect(startTool?.inputSchema).toMatchObject({ project: expect.any(String) });
      const sendTool = call?.tools.find((tool) => tool.name === "session.send");
      expect(sendTool?.inputSchema).toMatchObject({
        sessionId: expect.any(String),
        text: expect.any(String),
      });
      const killTool = call?.tools.find((tool) => tool.name === "session.kill");
      expect(killTool?.inputSchema).toMatchObject({ sessionId: expect.any(String) });
    });

    it("passes no running sessions when none have started", async () => {
      const ask = vi.fn<Brain["ask"]>(async () => ({ text: "ok", toolCalls: [] }));
      const orchestrator = build({ ask });
      await orchestrator.handle("hi", "en");
      expect(ask.mock.calls[0]?.[0]?.context.sessions).toEqual([]);
    });

    it("passes a started session's id so a later 'kill it' can resolve it", async () => {
      const agent = registry.resolve({ project: "acme" });
      const started = sessions.start({ project: "acme", projectPath: "/x", agent });

      const ask = vi.fn<Brain["ask"]>(async () => ({ text: "ok", toolCalls: [] }));
      const orchestrator = build({ ask });
      await orchestrator.handle("kill it", "en");

      expect(ask.mock.calls[0]?.[0]?.context.sessions).toEqual([
        {
          id: started.id,
          project: "acme",
          agentId: "claude-acme",
          state: started.state,
          summary: started.summary,
        },
      ]);
    });

    it("reflects a session started earlier in the same turn's tool call in the next turn's context", async () => {
      const first = build(
        brainReturning({
          text: "Starting.",
          toolCalls: [{ name: "session.start", input: { project: "acme" } }],
        }),
      );
      await first.handle("افتح متجر أكمي", "ar");
      const sessionId = sessions.list()[0]?.id;

      const ask = vi.fn<Brain["ask"]>(async () => ({ text: "ok", toolCalls: [] }));
      const second = build({ ask });
      await second.handle("اقفلها", "ar");

      const sessionIds = ask.mock.calls[0]?.[0]?.context.sessions.map((session) => session.id);
      expect(sessionIds).toContain(sessionId);
    });
  });

  describe("tool dispatch seam", () => {
    it("dispatches every declared tool name to a handler, never to unknownTool", async () => {
      const calls: string[] = [];
      const brain: Brain = {
        ask: async () => ({
          text: "ok",
          toolCalls: TOOL_NAMES.map((name) => ({ name, input: {} })),
        }),
      };
      const orchestrator = build(brain);

      const turn = await orchestrator.handle("do everything", "en");
      calls.push(turn.text);

      expect(turn.text).not.toContain("I don't know how to do that");
    });

    it("still reports a tool name nobody declared", async () => {
      const brain: Brain = {
        ask: async () => ({ text: "ok", toolCalls: [{ name: "session.explode", input: {} }] }),
      };
      const orchestrator = build(brain);
      const turn = await orchestrator.handle("explode", "en");
      expect(turn.text).toContain('I don\'t know how to do that ("session.explode")');
    });
  });
});

describe("git tools", () => {
  let sessions: SessionManager;
  let speak: ReturnType<typeof vi.fn<(text: string, language: "ar" | "en") => Promise<void>>>;

  beforeEach(() => {
    sessions = new SessionManager(() => fakeProcess());
    speak = vi.fn(async () => {});
  });

  function buildOrchestrator(options: {
    brain: Brain;
    git?: GitProvider;
    changes?: () => SessionChanges[];
    providers?: { snapshot(): ProviderStatus[]; refresh(): Promise<void> };
  }): Orchestrator {
    return new Orchestrator({
      brain: options.brain,
      registry,
      sessions,
      git: options.git ?? fakeGitProvider(),
      changes: options.changes ?? (() => []),
      speak,
      projects: { acme: "/Users/x/projects/acme" },
      providers: options.providers ?? { snapshot: () => [], refresh: async () => {} },
    });
  }

  // Stubs SessionManager#get so a fixed, known session id resolves without
  // needing a real spawned process — the git tools only ever read the
  // session's projectPath, never its process handle.
  async function startTestSession(_orchestrator: Orchestrator, id: string): Promise<void> {
    const session: Session = {
      id,
      project: "acme",
      projectPath: "/Users/x/projects/acme",
      agentId: "claude-acme",
      state: "running",
      summary: "",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    vi.spyOn(sessions, "get").mockImplementation((sessionId) =>
      sessionId === id ? session : undefined,
    );
  }

  it("answers git.status with the branch and counts, in Arabic", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "شوف كده.",
          toolCalls: [{ name: "git.status", input: { sessionId: "s1" } }],
        }),
      },
      git: fakeGitProvider(),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("وريني التغييرات", "ar");

    expect(turn.text).toContain("الفرع: feat/checkout-retry");
    expect(turn.text).toContain("الملفات المعدّلة: 1");
    expect(turn.view).toBe("changes");
  });

  it("carries the file path on a git.diff turn so the view can open it", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.diff", input: { sessionId: "s1", path: "a.php" } }],
        }),
      },
      git: fakeGitProvider(),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("show me a.php", "en");

    expect(turn.view).toBe("changes");
    expect(turn.path).toBe("a.php");
    expect(turn.text).toContain("Opened the diff for a.php");
  });

  it("falls back to staging tracked-modified files when nothing is staged", async () => {
    const staged: string[][] = [];
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.commit", input: { sessionId: "s1", message: "إصلاح الدفع" } }],
        }),
      },
      git: fakeGitProvider({
        stage: async (_repoPath, paths) => {
          staged.push(paths);
          return { ok: true, value: null };
        },
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("احفظ التغييرات", "ar");

    expect(staged).toEqual([["a.php"]]);
    expect(turn.text).toContain("a1b2c3d");
  });

  // Controller ruling P27: voice commit must agree with what the user
  // already staged by hand, never override it with "everything git status
  // shows".
  it("commits only files the user already staged, without staging anything new", async () => {
    const staged: string[][] = [];
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.commit", input: { sessionId: "s1", message: "fix" } }],
        }),
      },
      git: fakeGitProvider({
        changes: async (repoPath) => ({
          ok: true,
          value: {
            repoPath,
            branch: "feat/checkout-retry",
            detached: false,
            files: [
              { path: "a.php", status: "M", insertions: 3, deletions: 1, staged: true },
              { path: "b.php", status: "M", insertions: 1, deletions: 0, staged: false },
              { path: "scratch.txt", status: "?", insertions: 0, deletions: 0, staged: false },
            ],
            insertions: 4,
            deletions: 1,
          },
        }),
        stage: async (_repoPath, paths) => {
          staged.push(paths);
          return { ok: true, value: null };
        },
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("commit", "en");

    // Nothing is staged again: a.php was already staged, b.php and the
    // untracked scratch.txt are deliberately left alone.
    expect(staged).toEqual([]);
    expect(turn.text).toContain("a1b2c3d");
  });

  it("never auto-stages an untracked file, even in the fallback path, and names the count left out", async () => {
    const staged: string[][] = [];
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.commit", input: { sessionId: "s1", message: "احفظ" } }],
        }),
      },
      git: fakeGitProvider({
        changes: async (repoPath) => ({
          ok: true,
          value: {
            repoPath,
            branch: "feat/checkout-retry",
            detached: false,
            files: [
              { path: "a.php", status: "M", insertions: 3, deletions: 1, staged: false },
              { path: ".env.local", status: "?", insertions: 0, deletions: 0, staged: false },
              { path: "scratch.txt", status: "?", insertions: 0, deletions: 0, staged: false },
            ],
            insertions: 3,
            deletions: 1,
          },
        }),
        stage: async (_repoPath, paths) => {
          staged.push(paths);
          return { ok: true, value: null };
        },
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("احفظ التغييرات", "ar");

    expect(staged).toEqual([["a.php"]]);
    expect(turn.text).toContain("ملفات غير متتبعة استُبعدت: 2.");
  });

  it("reports a git failure in the user's language and still answers", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "تمام.",
          toolCalls: [{ name: "git.status", input: { sessionId: "s1" } }],
        }),
      },
      git: fakeGitProvider({
        changes: async () => ({ ok: false, error: { code: "not-a-repo", detail: "/p" } }),
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("وريني التغييرات", "ar");

    expect(turn.text).toContain("هذا المجلد ليس مستودع git.");
    expect(turn.role).toBe("assistant");
  });

  it("reports an unknown session id rather than reading some other repository", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.status", input: { sessionId: "ghost" } }],
        }),
      },
      git: fakeGitProvider(),
    });

    const turn = await orchestrator.handle("status", "en");

    expect(turn.text).toContain('I don\'t know a session called "ghost"');
  });

  it("refuses to commit without a message instead of committing an empty one", async () => {
    const commits: string[] = [];
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.commit", input: { sessionId: "s1" } }],
        }),
      },
      git: fakeGitProvider({
        commit: async (_repoPath, message) => {
          commits.push(message);
          return { ok: false, error: { code: "empty-message", detail: "" } };
        },
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("commit", "en");

    expect(turn.text).toContain("Write a commit message first.");
  });

  it("names the project and the file count in a commit confirmation", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.commit", input: { sessionId: "s1", message: "إصلاح الدفع" } }],
        }),
      },
      git: fakeGitProvider({
        commit: async () => ({ ok: true, value: { sha: "a1b2c3d", filesChanged: 4 } }),
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("احفظ التغييرات", "ar");

    expect(turn.text).toContain("acme");
    expect(turn.text).toContain("4");
    expect(turn.text).toContain("a1b2c3d");
  });

  it("reports a git.diff failure, such as insideRepo rejecting a path escaping the repository", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.diff", input: { sessionId: "s1", path: "../../etc/passwd" } }],
        }),
      },
      git: fakeGitProvider({
        diff: async () => ({
          ok: false,
          error: { code: "failed", detail: "path escapes repository" },
        }),
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("show me ../../etc/passwd", "en");

    expect(turn.text).toContain("The git command failed: path escapes repository");
    expect(turn.view).toBeUndefined();
    expect(turn.path).toBeUndefined();
  });

  it("still calls git.diff with an empty path rather than throwing when the model omits it", async () => {
    const seenPaths: string[] = [];
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.diff", input: { sessionId: "s1" } }],
        }),
      },
      git: fakeGitProvider({
        diff: async (_repoPath, path) => {
          seenPaths.push(path);
          return { ok: false, error: { code: "failed", detail: "no path given" } };
        },
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("show me the diff", "en");

    expect(seenPaths).toEqual([""]);
    expect(turn.text).toContain("The git command failed: no path given");
  });

  it("announces a binary diff instead of an opened diff", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.diff", input: { sessionId: "s1", path: "logo.png" } }],
        }),
      },
      git: fakeGitProvider({
        diff: async (_repoPath, path) => ({
          ok: true,
          value: { path, binary: true, hunks: [] },
        }),
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("show me logo.png", "en");

    expect(turn.text).not.toContain("Opened the diff");
    expect(turn.text).toContain("Binary");
    expect(turn.view).toBe("changes");
    expect(turn.path).toBe("logo.png");
  });

  it("announces a too-large diff instead of an opened diff", async () => {
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.diff", input: { sessionId: "s1", path: "dump.sql" } }],
        }),
      },
      git: fakeGitProvider({
        diff: async (_repoPath, path) => ({
          ok: true,
          value: { path, binary: false, tooLarge: true, hunks: [] },
        }),
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("show me dump.sql", "en");

    expect(turn.text).not.toContain("Opened the diff");
    expect(turn.text).toContain("Too large");
  });

  it("reports a stage failure inside git.commit instead of committing anyway", async () => {
    const committed: string[] = [];
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.commit", input: { sessionId: "s1", message: "fix" } }],
        }),
      },
      git: fakeGitProvider({
        stage: async () => ({ ok: false, error: { code: "failed", detail: "permission denied" } }),
        commit: async (_repoPath, message) => {
          committed.push(message);
          return { ok: true, value: { sha: "shouldnotrun", filesChanged: 1 } };
        },
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("commit", "en");

    expect(turn.text).toContain("The git command failed: permission denied");
    expect(committed).toEqual([]);
  });

  it("reports the changes lookup failure inside git.commit before staging or committing", async () => {
    const staged: string[][] = [];
    const committed: string[] = [];
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async () => ({
          text: "ok",
          toolCalls: [{ name: "git.commit", input: { sessionId: "s1", message: "fix" } }],
        }),
      },
      git: fakeGitProvider({
        changes: async () => ({ ok: false, error: { code: "not-a-repo", detail: "/p" } }),
        stage: async (_repoPath, paths) => {
          staged.push(paths);
          return { ok: true, value: null };
        },
        commit: async (_repoPath, message) => {
          committed.push(message);
          return { ok: true, value: { sha: "shouldnotrun", filesChanged: 1 } };
        },
      }),
    });
    await startTestSession(orchestrator, "s1");

    const turn = await orchestrator.handle("commit", "en");

    expect(turn.text).toContain("That folder isn't a git repository.");
    expect(staged).toEqual([]);
    expect(committed).toEqual([]);
  });

  it("rebuilds the change context on every turn instead of caching it", async () => {
    const seen: number[] = [];
    let files = 1;
    const orchestrator = buildOrchestrator({
      brain: {
        ask: async ({ context }) => {
          seen.push(context.changes[0]?.files ?? 0);
          return { text: "ok", toolCalls: [] };
        },
      },
      changes: () => [
        {
          sessionId: "s1",
          project: "p",
          repoPath: "/p",
          branch: "main",
          detached: false,
          files,
          insertions: 0,
          deletions: 0,
        },
      ],
    });

    await orchestrator.handle("one", "en");
    files = 5;
    await orchestrator.handle("two", "en");

    expect(seen).toEqual([1, 5]);
  });

  describe("providers.status", () => {
    const statuses: ProviderStatus[] = [
      {
        id: "claude-main",
        vendor: "anthropic",
        capacity: {
          state: "known",
          primary: { usedPercent: 62, resetsAt: "2026-08-31T14:30:00Z" },
          secondary: undefined,
          readAt: Date.parse("2026-08-31T12:12:00Z"),
        },
        health: { state: "ok", detail: "ok", readAt: 1 },
      },
      {
        id: "copilot",
        vendor: "github",
        capacity: { state: "unknown", reason: "unsupported" },
        health: { state: "degraded", detail: "Partially Degraded Service", readAt: 1 },
      },
    ];

    it("answers with one line per provider, without spending a query", async () => {
      const refresh = vi.fn(async () => {});
      const brain: Brain = {
        ask: async () => ({ text: "", toolCalls: [{ name: "providers.status", input: {} }] }),
      };
      const orchestrator = buildOrchestrator({
        brain,
        providers: { snapshot: () => statuses, refresh },
      });

      const turn = await orchestrator.handle("which account can I use", "en");

      expect(turn.text).toContain("claude-main");
      expect(turn.text).toContain("38%");
      expect(turn.text).toContain("copilot");
      // Reading the cache is free; a spoken question must not silently bill.
      expect(refresh).not.toHaveBeenCalled();
    });

    it("refreshes first when the user explicitly asks for a fresh reading", async () => {
      const refresh = vi.fn(async () => {});
      const brain: Brain = {
        ask: async () => ({
          text: "",
          toolCalls: [{ name: "providers.status", input: { refresh: "yes" } }],
        }),
      };
      const orchestrator = buildOrchestrator({
        brain,
        providers: { snapshot: () => statuses, refresh },
      });

      await orchestrator.handle("check the accounts now", "en");
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("still answers from the cache when a refresh fails", async () => {
      const brain: Brain = {
        ask: async () => ({
          text: "",
          toolCalls: [{ name: "providers.status", input: { refresh: "yes" } }],
        }),
      };
      const orchestrator = buildOrchestrator({
        brain,
        providers: {
          snapshot: () => statuses,
          refresh: async () => {
            throw new Error("offline");
          },
        },
      });

      const turn = await orchestrator.handle("check now", "en");
      expect(turn.text).toContain("claude-main");
    });

    it("answers in Arabic when the user spoke Arabic", async () => {
      const brain: Brain = {
        ask: async () => ({ text: "", toolCalls: [{ name: "providers.status", input: {} }] }),
      };
      const orchestrator = buildOrchestrator({
        brain,
        providers: { snapshot: () => statuses, refresh: async () => {} },
      });

      const turn = await orchestrator.handle("أي حساب أقدر أستخدم؟", "ar");
      expect(turn.text).toContain("المتبقي 38%");
    });
  });
});
