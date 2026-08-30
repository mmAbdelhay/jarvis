import { beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import type { Brain, BrainReply } from "./types.js";
import { AgentRegistry } from "../registry/registry.js";
import { SessionManager } from "../session/manager.js";
import type { ProcessHandle } from "../session/types.js";

const registry = new AgentRegistry({
  agents: {
    "claude-mm": { command: "claude-mm", model: "opus", default: true },
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
      speak,
      projects: { acme: "/Users/x/projects/acme" },
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

  it("starts a session when the brain calls session.start", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Starting.",
        toolCalls: [{ name: "session.start", input: { project: "acme" } }],
      }),
    );
    const turn = await orchestrator.handle("افتح سعودي سيل", "ar");
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.list()[0]?.agentId).toBe("claude-acme");
    expect(turn.sessionId).toBe(sessions.list()[0]?.id);
    expect(turn.agentId).toBe("claude-acme");
  });

  it("honours an explicit agent in the tool call", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Using mm.",
        toolCalls: [{ name: "session.start", input: { project: "acme", agent: "claude-mm" } }],
      }),
    );
    await orchestrator.handle("use my main account", "en");
    expect(sessions.list()[0]?.agentId).toBe("claude-mm");
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
    const orchestrator = build({ ask: async () => { throw new Error("rate limited"); } });
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
      speak,
      projects: { acme: "/Users/x/projects/acme" },
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
          { name: "session.start", input: { project: "acme", agent: "claude-mm" } },
        ],
      }),
    );
    const turn = await orchestrator.handle("open both", "en");
    expect(sessions.list()).toHaveLength(2);
    const second = sessions.list()[1];
    expect(turn.sessionId).toBe(second?.id);
    expect(turn.agentId).toBe("claude-mm");
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

  it("keeps the transcript across turns", async () => {
    const orchestrator = build(brainReturning({ text: "ok", toolCalls: [] }));
    await orchestrator.handle("one", "en");
    await orchestrator.handle("two", "en");
    expect(orchestrator.transcript()).toHaveLength(4);
  });
});
