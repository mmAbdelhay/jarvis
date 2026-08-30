import { describe, expect, it } from "vitest";
import { createBrain, parseCliReply, type SdkQueryFn } from "./brain.js";

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

const tools = [
  { name: "session.start", description: "Start a coding session." },
  { name: "session.kill", description: "Kill a coding session." },
];

describe("createBrain", () => {
  it("returns the SDK's text reply for the current utterance", async () => {
    const { query } = fakeSdkQuery([[textMessage("Started the tests.")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    const reply = await brain.ask({ text: "run the tests", tools });

    expect(reply).toEqual({ text: "Started the tests.", toolCalls: [] });
  });

  it("concatenates multiple assistant text chunks into one reply", async () => {
    const { query } = fakeSdkQuery([[textMessage("Star"), textMessage("ted.")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    const reply = await brain.ask({ text: "run the tests", tools });

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

    const reply = await brain.ask({ text: "open acme", tools });

    expect(reply).toEqual({
      text: "Opening the project.",
      toolCalls: [{ name: "session.start", input: { project: "acme" } }],
    });
  });

  it("sends the current utterance and describes every available tool in the prompt", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "kill it", tools });

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.prompt).toContain("kill it");
    expect(call?.prompt).toContain("session.start: Start a coding session.");
    expect(call?.prompt).toContain("session.kill: Kill a coding session.");
  });

  it("does not send prior conversation turns as part of the prompt", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("first")], [textMessage("second")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "first utterance", tools });
    await brain.ask({ text: "second utterance", tools });

    const secondCall = calls[1];
    expect(secondCall).toBeDefined();
    expect(secondCall?.prompt).not.toContain("first utterance");
  });

  it("starts the first turn without resuming any prior session", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "hello", tools });

    expect(calls[0]?.options?.resume).toBeUndefined();
  });

  it("resumes the same SDK session on the next call so context carries over", async () => {
    const { query, calls } = fakeSdkQuery([
      [{ type: "system", subtype: "init", session_id: "sess-1" }, textMessage("ok")],
      [textMessage("ok again")],
    ]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "hello", tools });
    await brain.ask({ text: "ok kill it", tools });

    expect(calls[1]?.options?.resume).toBe("sess-1");
  });

  it("runs the session in the configured cwd with no inherited project settings", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({
      systemPrompt: "You are Jarvis.",
      cwd: "/tmp/jarvis-brain-isolated",
      query,
    });

    await brain.ask({ text: "hello", tools });

    expect(calls[0]?.options?.cwd).toBe("/tmp/jarvis-brain-isolated");
    expect(calls[0]?.options?.settingSources).toEqual([]);
  });

  it("disables built-in SDK tools so the model can only describe jarvis tool calls", async () => {
    const { query, calls } = fakeSdkQuery([[textMessage("ok")]]);
    const brain = createBrain({ systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain", query });

    await brain.ask({ text: "hello", tools });

    expect(calls[0]?.options?.tools).toEqual([]);
  });
});
