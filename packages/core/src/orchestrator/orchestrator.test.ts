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

  it("ignores tool calls that are not session.start", async () => {
    const orchestrator = build(
      brainReturning({
        text: "Sent.",
        toolCalls: [{ name: "session.send", input: { sessionId: "abc", text: "go" } }],
      }),
    );
    const turn = await orchestrator.handle("send go", "en");
    expect(sessions.list()).toHaveLength(0);
    expect(turn).toMatchObject({ text: "Sent." });
    expect(turn.sessionId).toBeUndefined();
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
    const listener = vi.fn();
    const unsubscribe = orchestrator.onTurn(listener);
    unsubscribe();
    await orchestrator.handle("hi", "en");
    expect(listener).not.toHaveBeenCalled();
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
