import { describe, expect, it } from "vitest";
import { MAX_CHAT_TURNS } from "./session-import.js";
import { parseCodexChat, parseCopilotChat } from "./agent-chat.js";

// Invented fixtures in the record shapes the two CLIs document.
describe("parseCopilotChat", () => {
  const event = (type: string, data: Record<string, unknown>): string =>
    JSON.stringify({ id: "e", timestamp: "2026-01-01T00:00:00Z", parentId: null, type, data });

  it("reads messages and gives each tool its target from object or string arguments", () => {
    const text = [
      event("user.message", { content: " fix it " }),
      event("assistant.message", {
        content: "Looking.",
        model: "gpt-5",
        toolRequests: [
          { toolCallId: "a", name: "bash", arguments: { command: "ls -la\npwd" } },
          {
            toolCallId: "b",
            name: "view",
            arguments: JSON.stringify({ file_path: "/w/src/app.ts" }),
          },
          { toolCallId: "c", name: "edit", arguments: "{not json" },
          { toolCallId: "d", name: "view", arguments: { path: "/w/README.md" } },
        ],
      }),
      event("assistant.message", { content: "", toolRequests: [{ name: "bash" }] }),
      event("assistant.message", { content: "Done." }),
    ].join("\n");
    const out = parseCopilotChat(text);
    expect(out.turns).toEqual([
      { role: "user", text: "fix it", tools: [] },
      {
        role: "assistant",
        text: "Looking.",
        tools: [
          { name: "bash", target: "ls -la" },
          { name: "view", target: "app.ts" },
          { name: "edit" },
          { name: "view", target: "README.md" },
          { name: "bash" },
        ],
      },
      { role: "assistant", text: "Done.", tools: [] },
    ]);
    expect(out.model).toBe("gpt-5");
  });

  it("takes the model from the last assistant message or model change", () => {
    const text = [
      event("assistant.message", { content: "a", model: "m1" }),
      event("session.model_change", { newModel: "m2" }),
    ].join("\n");
    expect(parseCopilotChat(text).model).toBe("m2");
    const later = [text, event("assistant.message", { content: "b", model: "m3" })].join("\n");
    expect(parseCopilotChat(later).model).toBe("m3");
  });

  it("skips injected, autopilot and sub-agent messages and a record cut mid-way", () => {
    const text = [
      'ssage","data":{"content":"cut off tail',
      event("user.message", { content: "skill", source: "skill-x" }),
      event("user.message", { content: "go on", isAutopilotContinuation: true }),
      event("assistant.message", { content: "sub", parentToolCallId: "t" }),
      "42",
      event("user.message", { content: "real" }),
    ].join("\n");
    expect(parseCopilotChat(text).turns).toEqual([{ role: "user", text: "real", tools: [] }]);
  });

  it("keeps only the last maxTurns and never throws on junk", () => {
    const text = Array.from({ length: 5 }, (_, i) =>
      event("user.message", { content: `m${i}` }),
    ).join("\n");
    expect(parseCopilotChat(text, 2).turns.map((t) => t.text)).toEqual(["m3", "m4"]);
    expect(parseCopilotChat(text).turns).toHaveLength(5);
    expect(MAX_CHAT_TURNS).toBeGreaterThan(5);
    expect(parseCopilotChat("\u0000{[").turns).toEqual([]);
  });
});

describe("parseCodexChat", () => {
  const completed = (item: Record<string, unknown>): string =>
    JSON.stringify({
      timestamp: "t",
      type: "event_msg",
      payload: { type: "item_completed", item },
    });
  const message = (role: string, text: string): string =>
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      },
    });

  it("reads item_completed messages and commands, never tool output or reasoning", () => {
    const text = [
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex" } }),
      completed({ type: "UserMessage", content: [{ type: "Text", text: "run the tests" }] }),
      completed({ type: "Reasoning", text: "secret thoughts" }),
      completed({
        type: "CommandExecution",
        command: ["bash", "-lc", "pnpm test\nsecond"],
        aggregated_output: "OUTPUT MUST NOT APPEAR",
      }),
      completed({ type: "CommandExecution", command: "ls -la\nmore" }),
      completed({ type: "FileChange", changes: { "/w/src/a.ts": {}, "/w/b.ts": {} } }),
      completed({
        type: "AgentMessage",
        content: [
          { type: "Text", text: "All " },
          { type: "Text", text: "green." },
        ],
      }),
    ].join("\n");
    const out = parseCodexChat(text);
    expect(out.turns).toEqual([
      { role: "user", text: "run the tests", tools: [] },
      {
        role: "assistant",
        text: "",
        tools: [
          { name: "exec", target: "bash -lc pnpm test" },
          { name: "exec", target: "ls -la" },
          { name: "edit", target: "a.ts" },
          { name: "edit", target: "b.ts" },
        ],
      },
      { role: "assistant", text: "All green.", tools: [] },
    ]);
    expect(out.model).toBe("gpt-5-codex");
    expect(JSON.stringify(out)).not.toContain("OUTPUT MUST NOT APPEAR");
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("falls back to response_item messages in an older rollout, dropping injected text", () => {
    const text = [
      message("developer", "system stuff"),
      message("user", "<environment_context>cwd</environment_context>"),
      message("user", "<user_instructions>x</user_instructions>"),
      message("user", "<skills_instructions>x</skills_instructions>"),
      message("user", "# AGENTS.md instructions for /w"),
      message("user", "hello"),
      message("assistant", "hi there"),
    ].join("\n");
    expect(parseCodexChat(text).turns).toEqual([
      { role: "user", text: "hello", tools: [] },
      { role: "assistant", text: "hi there", tools: [] },
    ]);
  });

  it("never mixes the two sources, so nothing appears twice", () => {
    const text = [
      message("user", "hello"),
      completed({ type: "UserMessage", content: [{ type: "Text", text: "hello" }] }),
      message("assistant", "yo"),
      completed({ type: "AgentMessage", content: [{ type: "Text", text: "yo" }] }),
    ].join("\n");
    expect(parseCodexChat(text).turns).toEqual([
      { role: "user", text: "hello", tools: [] },
      { role: "assistant", text: "yo", tools: [] },
    ]);
  });

  it("survives a tail that starts mid-record, caps turns and never throws", () => {
    const text = [
      'ompleted","item":{"type":"UserMessage"',
      ...Array.from({ length: 4 }, (_, i) =>
        completed({ type: "UserMessage", content: [{ type: "Text", text: `m${i}` }] }),
      ),
      "[1,2]",
      "null",
    ].join("\n");
    expect(parseCodexChat(text, 2).turns.map((t) => t.text)).toEqual(["m2", "m3"]);
    expect(parseCodexChat("{{{").turns).toEqual([]);
  });
});
