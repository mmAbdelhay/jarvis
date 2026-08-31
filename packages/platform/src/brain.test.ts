import { describe, expect, it, vi } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { BrainContext, ToolSpec } from "@jarvis/core";
import { createBrain, parseCliReply, type BrainSdkMessage, type SdkQueryFn } from "./brain.js";

describe("parseCliReply", () => {
  it("reads plain text with no tool calls", () => {
    expect(parseCliReply("Started the tests.")).toEqual({
      text: "Started the tests.",
      toolCalls: [],
    });
  });

  it("extracts a fenced tool call and strips it from the text", () => {
    const stdout = [
      "Opening the project.",
      "```jarvis-tool",
      '{ "name": "session.start", "input": { "project": "acme" } }',
      "```",
    ].join("\n");

    expect(parseCliReply(stdout)).toEqual({
      text: "Opening the project.",
      toolCalls: [{ name: "session.start", input: { project: "acme" } }],
    });
  });

  it("extracts several tool calls in order", () => {
    const stdout = [
      "Doing two things.",
      "```jarvis-tool",
      '{ "name": "session.start", "input": { "project": "a" } }',
      "```",
      "```jarvis-tool",
      '{ "name": "session.start", "input": { "project": "b" } }',
      "```",
    ].join("\n");

    const reply = parseCliReply(stdout);
    expect(reply.toolCalls.map((c) => c.input["project"])).toEqual(["a", "b"]);
  });

  it("ignores a malformed tool block rather than throwing", () => {
    const stdout = ["Text.", "```jarvis-tool", "{ not json", "```"].join("\n");
    expect(parseCliReply(stdout)).toEqual({ text: "Text.", toolCalls: [] });
  });

  it("preserves Arabic text unchanged", () => {
    expect(parseCliReply("تمام، شغلت الاختبارات").text).toBe("تمام، شغلت الاختبارات");
  });

  it("trims surrounding whitespace", () => {
    expect(parseCliReply("\n\n  hello  \n\n").text).toBe("hello");
  });
});

// --- createBrain (Agent SDK adapter) -------------------------------------

type FakeContentBlock = { type: string; text?: string };
type FakeMessage =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "assistant"; message: { content: FakeContentBlock[] } }
  | { type: "result" };

/**
 * Builds a fake `query` function that records every call's params and, on
 * the Nth call, yields the Nth entry of `turns` (an empty stream if there
 * are more calls than configured turns).
 */
function fakeSdkQuery(turns: FakeMessage[][]) {
  const calls: Parameters<SdkQueryFn>[0][] = [];
  let callCount = 0;

  const query: SdkQueryFn = (params) => {
    calls.push(params);
    const turn = turns[callCount] ?? [];
    callCount += 1;
    return (async function* () {
      for (const message of turn) yield message;
    })();
  };

  return { query, calls };
}

function textMessage(text: string): FakeMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

const tools: ToolSpec[] = [
  {
    name: "session.start",
    description: "Start a coding session.",
    inputSchema: { project: "name of the project to open" },
  },
  {
    name: "session.kill",
    description: "Kill a coding session.",
    inputSchema: { sessionId: "id of the session to stop" },
  },
];

const emptyContext: BrainContext = { projects: [], sessions: [], changes: [] };

describe("createBrain", () => {
  it("returns the SDK's text reply for the current utterance", async () => {
    const { query } = fakeSdkQuery([[textMessage("Started the tests.")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    const reply = await brain.ask({ text: "run the tests", tools, context: emptyContext });

    expect(reply).toEqual({ text: "Started the tests.", toolCalls: [] });
  });

  it("concatenates multiple assistant text chunks into one reply", async () => {
    const { query } = fakeSdkQuery([[textMessage("Star"), textMessage("ted.")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    const reply = await brain.ask({ text: "run the tests", tools, context: emptyContext });

    expect(reply.text).toBe("Started.");
  });

  it("extracts tool calls the model emits as fenced jarvis-tool blocks", async () => {
    const stdout = [
      "Opening the project.",
      "```jarvis-tool",
      '{ "name": "session.start", "input": { "project": "acme" } }',
      "```",
    ].join("\n");
    const { query } = fakeSdkQuery([[textMessage(stdout)]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    const reply = await brain.ask({ text: "open acme", tools, context: emptyContext });

    expect(reply).toEqual({
      text: "Opening the project.",
      toolCalls: [{ name: "session.start", input: { project: "acme" } }],
    });
  });

  it("sends the current utterance and describes every available tool in the prompt", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "kill it", tools, context: emptyContext });

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.prompt).toContain("kill it");
    expect(call?.prompt).toContain("session.start: Start a coding session.");
    expect(call?.prompt).toContain("session.kill: Kill a coding session.");
  });

  it("includes each tool's input schema in the prompt", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "kill it", tools, context: emptyContext });

    const call = calls[0];
    expect(call?.prompt).toContain("project (name of the project to open)");
    expect(call?.prompt).toContain("sessionId (id of the session to stop)");
  });

  it("lists the known project names in the prompt", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({
      text: "افتح سعودي سيل",
      tools,
      context: { projects: ["acme", "storefront"], sessions: [], changes: [] },
    });

    const call = calls[0];
    expect(call?.prompt).toContain("Known projects: acme, storefront");
  });

  it("lists running sessions with their ids so the model can address them", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({
      text: "kill it",
      tools,
      context: {
        projects: [],
        sessions: [
          {
            id: "sess-abc",
            project: "acme",
            agentId: "claude-acme",
            state: "running",
            summary: "running tests",
          },
        ],
        changes: [],
      },
    });

    const call = calls[0];
    expect(call?.prompt).toContain("sess-abc");
    expect(call?.prompt).toContain("acme");
    expect(call?.prompt).toContain("claude-acme");
    expect(call?.prompt).toContain("running tests");
  });

  it("says no projects or sessions are known when both lists are empty", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "hello", tools, context: emptyContext });

    const call = calls[0];
    expect(call?.prompt).toContain("no projects configured");
    expect(call?.prompt).toContain("no sessions running");
  });

  it("does not send prior conversation turns as part of the prompt", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("first")], [textMessage("second")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "first utterance", tools, context: emptyContext });
    await brain.ask({ text: "second utterance", tools, context: emptyContext });

    const secondCall = calls[1];
    expect(secondCall).toBeDefined();
    expect(secondCall?.prompt).not.toContain("first utterance");
  });

  it("starts the first turn without resuming any prior session", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "hello", tools, context: emptyContext });

    expect(calls[0]?.options?.resume).toBeUndefined();
  });

  it("resumes the same SDK session on the next call so context carries over", async () => {
    const { query, calls } = fakeSdkQuery([
      [{ type: "system", subtype: "init", session_id: "sess-1" }, textMessage("ok")],
      [textMessage("ok again")],
    ]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "hello", tools, context: emptyContext });
    await brain.ask({ text: "ok kill it", tools, context: emptyContext });

    expect(calls[1]?.options?.resume).toBe("sess-1");
  });

  it("runs the session in the configured cwd with no inherited project settings", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({
      systemPrompt: "You are Jarvis.",
      cwd: "/tmp/jarvis-brain-isolated",
      query,
    });

    await brain.ask({ text: "hello", tools, context: emptyContext });

    expect(calls[0]?.options?.cwd).toBe("/tmp/jarvis-brain-isolated");
    expect(calls[0]?.options?.settingSources).toEqual([]);
  });

  it("disables built-in SDK tools so the model can only describe jarvis tool calls", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "hello", tools, context: emptyContext });

    expect(calls[0]?.options?.tools).toEqual([]);
  });

  it("tells the model which sessions have uncommitted changes", async () => {
    let capturedPrompt = "";
    const brain = createBrain({
      systemPrompt: "You are Jarvis.",
      cwd: "/tmp",
      query: ({ prompt }) => {
        capturedPrompt = prompt;
        return (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
        })();
      },
    });

    await brain.ask({
      text: "what changed?",
      tools: [],
      context: {
        projects: ["acme"],
        sessions: [],
        changes: [
          {
            sessionId: "s1",
            project: "acme",
            repoPath: "/projects/acme",
            branch: "feat/checkout-retry",
            detached: false,
            files: 7,
            insertions: 128,
            deletions: 34,
          },
        ],
      },
    });

    expect(capturedPrompt).toContain(
      "s1 — project acme, branch feat/checkout-retry, 7 files, +128 -34",
    );
  });

  it("says so plainly when nothing is uncommitted", async () => {
    let capturedPrompt = "";
    const brain = createBrain({
      systemPrompt: "You are Jarvis.",
      cwd: "/tmp",
      query: ({ prompt }) => {
        capturedPrompt = prompt;
        return (async function* () {
          yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
        })();
      },
    });

    await brain.ask({ text: "hi", tools: [], context: { projects: [], sessions: [], changes: [] } });

    expect(capturedPrompt).toContain("Uncommitted changes: (none)");
  });
});

describe("capacity piggyback", () => {
  const usage = {
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 12, resets_at: "2026-08-31T14:30:00Z" } },
  };

  function usageQuery(messages: BrainSdkMessage[], response: unknown) {
    let drained = false;
    const query = {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
        drained = true;
      },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        if (drained) throw new Error("Query closed before response received");
        return response;
      },
    };
    return () => query;
  }

  const messages: BrainSdkMessage[] = [
    { type: "system", subtype: "init", session_id: "s1" },
    { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    { type: "result" },
  ];

  it("reports the account's capacity for free when accountId is configured", async () => {
    const onUsage = vi.fn();
    const brain = createBrain({
      systemPrompt: "p",
      cwd: "/tmp/brain",
      accountId: "claude-mm",
      configDir: "/c/mm",
      onUsage,
      query: usageQuery(messages, usage),
    });

    await brain.ask({ text: "hello", tools: [], context: { projects: [], sessions: [], changes: [] } });

    expect(onUsage).toHaveBeenCalledWith("claude-mm", {
      ok: true,
      fiveHour: { usedPercent: 12, resetsAt: "2026-08-31T14:30:00Z" },
      sevenDay: undefined,
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("attributes nothing when no accountId is configured", async () => {
    const onUsage = vi.fn();
    const brain = createBrain({
      systemPrompt: "p",
      cwd: "/tmp/brain",
      onUsage,
      query: usageQuery(messages, usage),
    });

    await brain.ask({ text: "hello", tools: [], context: { projects: [], sessions: [], changes: [] } });
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("still answers normally when the experimental usage call throws", async () => {
    const onUsage = vi.fn();
    const brain = createBrain({
      systemPrompt: "p",
      cwd: "/tmp/brain",
      accountId: "claude-mm",
      configDir: "/c/mm",
      onUsage,
      query: () => ({
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
          throw new Error("DO_NOT_RELY_ON_THIS_API_YET");
        },
      }),
    });

    const reply = await brain.ask({
      text: "hello",
      tools: [],
      context: { projects: [], sessions: [], changes: [] },
    });

    // The assistant's answer is the product; the free reading is a bonus and
    // must never be able to break it.
    expect(reply.text).toBe("hi");
    expect(onUsage).toHaveBeenCalledWith("claude-mm", { ok: false, reason: "unavailable" });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("still answers normally when the caller-supplied onUsage throws", async () => {
    const onUsage = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const brain = createBrain({
      systemPrompt: "p",
      cwd: "/tmp/brain",
      accountId: "claude-mm",
      configDir: "/c/mm",
      onUsage,
      query: usageQuery(messages, usage),
    });

    // A throwing onUsage must not fall into the catch and be invoked a
    // second time (double-attribution for one turn), and must not escape
    // ask() either.
    const reply = await brain.ask({
      text: "hello",
      tools: [],
      context: { projects: [], sessions: [], changes: [] },
    });

    expect(reply.text).toBe("hi");
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("still answers normally when onUsage throws on the failure path too", async () => {
    const onUsage = vi.fn(() => {
      throw new Error("listener exploded");
    });
    const brain = createBrain({
      systemPrompt: "p",
      cwd: "/tmp/brain",
      accountId: "claude-mm",
      configDir: "/c/mm",
      onUsage,
      query: () => ({
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
        async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
          throw new Error("DO_NOT_RELY_ON_THIS_API_YET");
        },
      }),
    });

    const reply = await brain.ask({
      text: "hello",
      tools: [],
      context: { projects: [], sessions: [], changes: [] },
    });

    expect(reply.text).toBe("hi");
    expect(onUsage).toHaveBeenCalledWith("claude-mm", { ok: false, reason: "unavailable" });
    expect(onUsage).toHaveBeenCalledTimes(1);
  });

  it("works with a plain query function that exposes no usage method at all", async () => {
    const onUsage = vi.fn();
    const brain = createBrain({
      systemPrompt: "p",
      cwd: "/tmp/brain",
      accountId: "claude-mm",
      configDir: "/c/mm",
      onUsage,
      query: () =>
        (async function* () {
          for (const message of messages) yield message;
        })(),
    });

    const reply = await brain.ask({
      text: "hello",
      tools: [],
      context: { projects: [], sessions: [], changes: [] },
    });
    expect(reply.text).toBe("hi");
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("strips a set ANTHROPIC_API_KEY from the child env, matching capacity.ts", async () => {
    const original = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-reach-the-child";
    try {
      let capturedOptions: Options | undefined;
      const brain = createBrain({
        systemPrompt: "p",
        cwd: "/tmp/brain",
        accountId: "claude-mm",
        configDir: "/c/mm",
        onUsage: vi.fn(),
        query: ({ options }) => {
          capturedOptions = options;
          return usageQuery(messages, usage)();
        },
      });

      await brain.ask({ text: "hello", tools: [], context: { projects: [], sessions: [], changes: [] } });

      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env).toBeDefined();
      expect(env?.["ANTHROPIC_API_KEY"]).toBeUndefined();
      // The account override still wins — stripping the key must not
      // disturb the config-dir attribution the whole feature depends on.
      expect(env?.["CLAUDE_CONFIG_DIR"]).toBe("/c/mm");
    } finally {
      if (original === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = original;
    }
  });
});

