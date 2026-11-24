import { describe, expect, it } from "vitest";
import {
  type ChatDoc,
  type ChatToolItem,
  createClaudeDocReader,
  createCodexDocReader,
  createCopilotDocReader,
  parseClaudeDoc,
  parseCodexDoc,
  parseCopilotDoc,
} from "./agent-chat-doc.js";
import { parseChatTranscript } from "./session-import.js";
import { parseCodexChat, parseCopilotChat } from "./agent-chat.js";

// Invented records in the shapes the three CLIs write. Nothing here is a real transcript.
const T0 = "2026-01-01T10:00:00.000Z";
const T1 = "2026-01-01T10:00:05.000Z";
const line = (record: unknown): string => JSON.stringify(record);
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}): string =>
  line({ type: "user", uuid, timestamp: T0, message: { role: "user", content }, ...extra });
const assistant = (
  uuid: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
  message: Record<string, unknown> = {},
): string =>
  line({
    type: "assistant",
    uuid,
    timestamp: T0,
    message: { role: "assistant", model: "claude-test-1", content, ...message },
    ...extra,
  });
const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (id: string, content: unknown, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
});
const tools = (doc: ChatDoc): ChatToolItem[] =>
  doc.items.filter((item): item is ChatToolItem => item.kind === "tool");

describe("parseClaudeDoc", () => {
  it("keeps the true order of text and tools with stable ids", () => {
    const text = [
      user("u1", "fix the bug"),
      assistant("a1", [
        { type: "text", text: "Looking." },
        toolUse("t1", "Bash", { command: "ls -la\npwd" }),
        { type: "text", text: "Then this." },
        toolUse("t2", "Read", { file_path: "/w/src/app.ts" }),
      ]),
    ].join("\n");
    const doc = parseClaudeDoc(text);
    expect(doc.items.map((i) => [i.id, i.kind])).toEqual([
      ["u1:0", "user"],
      ["a1:0", "text"],
      ["t1", "tool"],
      ["a1:2", "text"],
      ["t2", "tool"],
    ]);
    expect(parseClaudeDoc(text).items.map((i) => i.id)).toEqual(doc.items.map((i) => i.id));
    const [bash, read] = tools(doc);
    expect(bash).toMatchObject({ tool: "Bash", target: "ls -la", command: "ls -la\npwd" });
    expect(read).toMatchObject({ tool: "Read", target: "app.ts", path: "/w/src/app.ts" });
    expect(doc.model).toBe("claude-test-1");
  });

  it("joins a tool result to its call by id with output, state and timing", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a1", [toolUse("t1", "Bash", { command: "false" })]),
        user(
          "u2",
          [toolResult("t1", [{ type: "text", text: "boom\u001b[31m red\u001b[0m\u0007" }], true)],
          {
            timestamp: T1,
          },
        ),
      ].join("\n"),
    );
    expect(doc.items).toHaveLength(1);
    expect(tools(doc)[0]).toMatchObject({
      state: "error",
      output: "boom red",
      at: Date.parse(T0),
      endAt: Date.parse(T1),
    });
  });

  it("shows a call with no result as ended (outcome unknown), never ok, and leaves the last one running", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a1", [toolUse("t1", "Bash", { command: "a" }), { type: "text", text: "go" }]),
        assistant("a2", [toolUse("t2", "Bash", { command: "b" })]),
      ].join("\n"),
    );
    expect(tools(doc).map((t) => t.state)).toEqual(["ended", "running"]);
  });

  it("takes a diff from structuredPatch, else from the old and new strings", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a1", [
          toolUse("e1", "Edit", { file_path: "/w/a.ts", old_string: "x\ny", new_string: "z" }),
          toolUse("e2", "Edit", { file_path: "/w/b.ts", old_string: "p", new_string: "q" }),
        ]),
        user("u2", [toolResult("e1", "updated")], {
          toolUseResult: {
            structuredPatch: [
              { oldStart: 1, lines: [" keep", "-x", "-y", "+z"] },
              { oldStart: 9, lines: ["-p", "+q"] },
            ],
          },
        }),
      ].join("\n"),
    );
    const [first, second] = tools(doc);
    expect(first?.diff).toEqual([
      { sign: " ", text: "keep" },
      { sign: "-", text: "x" },
      { sign: "-", text: "y" },
      { sign: "+", text: "z" },
      { sign: " ", text: "…" },
      { sign: "-", text: "p" },
      { sign: "+", text: "q" },
    ]);
    expect(second?.diff).toEqual([
      { sign: "-", text: "p" },
      { sign: "+", text: "q" },
    ]);
  });

  it("derives context from the last assistant usage", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a1", [{ type: "text", text: "a" }], {}, { usage: { input_tokens: 1 } }),
        assistant(
          "a2",
          [{ type: "text", text: "b" }],
          {},
          {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 3000,
              output_tokens: 99,
            },
          },
        ),
      ].join("\n"),
    );
    expect(doc.contextTokens).toBe(3210);
    expect(
      parseClaudeDoc(assistant("a", [{ type: "text", text: "a" }])).contextTokens,
    ).toBeUndefined();
  });

  it("keeps the last TodoWrite as the to-do list", () => {
    const write = (todos: unknown[]) => assistant("a", [toolUse("w", "TodoWrite", { todos })]);
    const doc = parseClaudeDoc(
      [
        write([{ content: "old", status: "pending" }]),
        write([
          { content: "one", status: "completed" },
          { content: "two", status: "in_progress", activeForm: "Doing two" },
          { content: "three", status: "pending" },
          { status: "pending" },
        ]),
      ].join("\n"),
    );
    expect(doc.todos).toEqual([
      { text: "one", state: "done" },
      { text: "two", state: "active" },
      { text: "three", state: "open" },
    ]);
    expect(parseClaudeDoc(user("u", "hi")).todos).toBeUndefined();
  });

  it("folds TaskCreate and TaskUpdate into a to-do list", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a", [
          toolUse("c1", "TaskCreate", { subject: "first" }),
          toolUse("c2", "TaskCreate", { subject: "second" }),
          toolUse("c3", "TaskCreate", { subject: "third" }),
        ]),
        assistant("b", [
          toolUse("u1", "TaskUpdate", { taskId: "1", status: "completed" }),
          toolUse("u2", "TaskUpdate", { taskId: "2", status: "in_progress" }),
          toolUse("u3", "TaskUpdate", { taskId: "3", status: "deleted" }),
          toolUse("u4", "TaskUpdate", { taskId: "9", status: "completed" }),
        ]),
      ].join("\n"),
    );
    expect(doc.todos).toEqual([
      { text: "first", state: "done" },
      { text: "second", state: "active" },
    ]);
  });

  it("tracks sub-agents from Task and Agent calls and their results", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a", [
          toolUse("s1", "Task", { description: "survey", subagent_type: "x" }),
          toolUse("s2", "Agent", { subagent_type: "reviewer" }),
        ]),
        user("u", [toolResult("s1", "done")], { timestamp: T1 }),
      ].join("\n"),
    );
    expect(doc.agents).toEqual([
      {
        id: "s1",
        label: "survey",
        state: "done",
        startedAt: Date.parse(T0),
        endedAt: Date.parse(T1),
      },
      { id: "s2", label: "reviewer", state: "running", startedAt: Date.parse(T0) },
    ]);
  });

  it("totals changed files, undoing a failed edit", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a", [
          toolUse("e1", "Edit", { file_path: "/w/a.ts", old_string: "x", new_string: "y\nz" }),
          toolUse("e2", "Write", { file_path: "/w/b.ts", content: "1\n2\n3\n" }),
          toolUse("e3", "Edit", { file_path: "/w/a.ts", old_string: "q\nr", new_string: "s" }),
          toolUse("e4", "Edit", { file_path: "/w/c.ts", old_string: "q", new_string: "s" }),
        ]),
        user("u", [toolResult("e4", "no match", true)]),
      ].join("\n"),
    );
    expect(doc.files).toEqual([
      { path: "/w/a.ts", added: 3, removed: 3 },
      { path: "/w/b.ts", added: 3, removed: 0 },
    ]);
  });

  it("skips meta, sidechain and local-command records and shows a compaction as a divider", () => {
    const doc = parseClaudeDoc(
      [
        user("m", "skill manual", { isMeta: true }),
        user("s", "sub talk", { isSidechain: true }),
        user("n", "<local-command-stdout>ok</local-command-stdout>"),
        user("c", "This session is being continued... SUMMARY WORDS", { isCompactSummary: true }),
        user("r", "<command-name>/plan</command-name><command-args>x</command-args>"),
        "{not json",
        "42",
        line({ type: "cost-state" }),
      ].join("\n"),
    );
    expect(doc.items).toEqual([
      { id: "c:0", kind: "divider", event: "compacted", at: Date.parse(T0) },
      { id: "r:0", kind: "user", text: "/plan x", at: Date.parse(T0) },
    ]);
    expect(JSON.stringify(doc)).not.toContain("SUMMARY WORDS");
  });

  it("caps text, output lines and diff lines, and strips control characters", () => {
    const big = "x".repeat(70_000);
    const lines = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const doc = parseClaudeDoc(
      [
        assistant("a", [
          { type: "text", text: big },
          toolUse("t", "Bash", { command: "c" }),
          toolUse("w", "Write", { file_path: "/w/f", content: lines }),
        ]),
        user("u", [toolResult("t", lines)]),
      ].join("\n"),
    );
    expect(doc.items[0]?.kind === "text" && doc.items[0].text.length).toBeLessThanOrEqual(
      64 * 1024,
    );
    const [bash, write] = tools(doc);
    expect(bash?.output?.split("\n")).toHaveLength(200);
    expect(bash?.outputCut).toBe(true);
    expect(write?.diff).toHaveLength(400);
  });

  it("never throws on junk and keeps going", () => {
    expect(() => parseClaudeDoc('\u0000{[\n\n{"type":"user","message":7}')).not.toThrow();
    expect(parseClaudeDoc("").items).toEqual([]);
    expect(parseClaudeDoc("").agents).toEqual([]);
    expect(parseClaudeDoc("").files).toEqual([]);
  });

  it("agrees with the phone reader on which turns exist", () => {
    const text = [
      user("u1", "hello"),
      assistant("a1", [{ type: "text", text: "hi" }, toolUse("t", "Bash", { command: "ls" })]),
      user("u2", [toolResult("t", "out")]),
      assistant("a2", [{ type: "text", text: "done" }]),
    ].join("\n");
    const phone = parseChatTranscript(text).turns.map((turn) => turn.text);
    const doc = parseClaudeDoc(text).items.flatMap((i) =>
      i.kind === "tool" || i.kind === "divider" ? [] : [i.text],
    );
    expect(doc).toEqual(phone.filter((t) => t !== ""));
  });
});

describe("parseClaudeDoc: injected records, images, background agents, tasks", () => {
  it("never shows injected text as the user's words", () => {
    const doc = parseClaudeDoc(
      [
        user(
          "a",
          "<task-notification><tool-use-id>zz</tool-use-id><status>completed</status></task-notification>",
        ),
        user("b", [{ type: "text", text: "<system-reminder>be good</system-reminder>" }]),
        user("c", [{ type: "text", text: "real words <system-reminder>hidden</system-reminder>" }]),
        user("d", "[Request interrupted by user for tool use]"),
        user("e", [{ type: "text", text: "<local-command-stdout>x</local-command-stdout>" }]),
      ].join("\n"),
    );
    expect(doc.items).toEqual([
      { id: "c:0", kind: "user", text: "real words", at: Date.parse(T0) },
      { id: "d:0", kind: "divider", event: "interrupted", at: Date.parse(T0) },
    ]);
  });

  it("counts images on a user message and shows an image-only message, never the bytes", () => {
    const img = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    };
    const doc = parseClaudeDoc(
      [user("a", [img, { type: "text", text: "look" }, img]), user("b", [img])].join("\n"),
    );
    expect(doc.items).toEqual([
      { id: "a:1", kind: "user", text: "look", images: 2, at: Date.parse(T0) },
      { id: "b:0", kind: "user", text: "", images: 1, at: Date.parse(T0) },
    ]);
    expect(JSON.stringify(doc)).not.toContain("AAAA");
  });

  it("keeps a background sub-agent running until its task notification", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a", [
          toolUse("s1", "Task", { description: "bg" }),
          toolUse("s2", "Task", { description: "fg" }),
        ]),
        user("u1", [toolResult("s1", "launched")], { toolUseResult: { status: "async_launched" } }),
        user("u2", [toolResult("s2", "launched")], { toolUseResult: { isAsync: true } }),
        user(
          "u3",
          "<task-notification><tool-use-id>s1</tool-use-id><status>completed</status></task-notification>",
          { timestamp: T1 },
        ),
      ].join("\n"),
    );
    expect(doc.agents.map((a) => [a.id, a.state])).toEqual([
      ["s1", "done"],
      ["s2", "running"],
    ]);
    expect(doc.agents[0]?.endedAt).toBe(Date.parse(T1));
    expect(doc.items.filter((i) => i.kind === "divider")).toEqual([
      { id: "u3:0", kind: "divider", event: "agentDone", label: "bg", at: Date.parse(T1) },
    ]);
  });

  it("marks a failed background agent", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a", [toolUse("s1", "Task", { description: "bg" })]),
        user("u1", [toolResult("s1", "x")], { toolUseResult: { status: "async_launched" } }),
        user(
          "u3",
          "<task-notification><tool-use-id>s1</tool-use-id><status>failed</status></task-notification>",
        ),
      ].join("\n"),
    );
    expect(doc.agents[0]?.state).toBe("failed");
  });

  it("maps TaskUpdate ids from the TaskCreate result text, creation order as fallback", () => {
    const doc = parseClaudeDoc(
      [
        assistant("a", [
          toolUse("c1", "TaskCreate", { subject: "first" }),
          toolUse("c2", "TaskCreate", { subject: "second" }),
        ]),
        user("r1", [toolResult("c1", "Task #7 created successfully: first")]),
        user("r2", [toolResult("c2", "Task #8 created successfully: second")]),
        assistant("b", [toolUse("u1", "TaskUpdate", { taskId: "8", status: "completed" })]),
      ].join("\n"),
    );
    expect(doc.todos).toEqual([
      { text: "first", state: "open" },
      { text: "second", state: "done" },
    ]);
  });
});

describe("parseCodexDoc: older rollouts' function calls", () => {
  const resp = (payload: Record<string, unknown>): string =>
    line({ timestamp: T0, type: "response_item", payload });

  it("reads shell calls and their outputs by call_id", () => {
    const doc = parseCodexDoc(
      [
        resp({ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }),
        resp({
          type: "function_call",
          name: "shell",
          call_id: "k1",
          arguments: JSON.stringify({ command: ["bash", "-lc", "ls\nmore"] }),
        }),
        resp({
          type: "function_call_output",
          call_id: "k1",
          output: JSON.stringify({ output: "a.txt", metadata: { exit_code: 0 } }),
        }),
        resp({
          type: "function_call",
          name: "shell",
          call_id: "k2",
          arguments: JSON.stringify({ command: ["false"] }),
        }),
        resp({ type: "function_call_output", call_id: "k2", output: "plain text out" }),
        resp({
          type: "function_call",
          name: "shell",
          call_id: "k3",
          arguments: JSON.stringify({ command: ["x"] }),
        }),
        resp({
          type: "function_call_output",
          call_id: "k3",
          output: JSON.stringify({ output: "no", metadata: { exit_code: 2 } }),
        }),
      ].join("\n"),
    );
    expect(tools(doc)).toMatchObject([
      {
        id: "k1",
        tool: "exec",
        command: "bash -lc ls\nmore",
        target: "bash -lc ls",
        output: "a.txt",
        state: "ok",
      },
      { id: "k2", output: "plain text out", state: "ok" },
      { id: "k3", output: "no", state: "error" },
    ]);
    expect(doc.items[0]).toMatchObject({ kind: "user", text: "go" });
  });

  it("keeps update_plan as to-dos only and reads apply_patch as files with diff lines", () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n keep\n-old\n+new\n+more\n*** Add File: b.txt\n+hello\n*** End Patch";
    const doc = parseCodexDoc(
      [
        resp({
          type: "function_call",
          name: "update_plan",
          call_id: "p",
          arguments: JSON.stringify({ plan: [{ step: "a", status: "pending" }] }),
        }),
        resp({ type: "custom_tool_call", name: "apply_patch", call_id: "k", input: patch }),
        resp({ type: "custom_tool_call_output", call_id: "k", output: "Done!" }),
      ].join("\n"),
    );
    expect(doc.todos).toEqual([{ text: "a", state: "open" }]);
    expect(tools(doc).map((t) => [t.tool, t.path])).toEqual([
      ["edit", "src/a.ts"],
      ["edit", "b.txt"],
    ]);
    expect(tools(doc)[0]?.diff).toEqual([
      { sign: " ", text: "keep" },
      { sign: "-", text: "old" },
      { sign: "+", text: "new" },
      { sign: "+", text: "more" },
    ]);
    expect(doc.files).toEqual([
      { path: "src/a.ts", added: 2, removed: 1 },
      { path: "b.txt", added: 1, removed: 0 },
    ]);
  });
});

describe("reader buffering", () => {
  it("reads a whole last record on doc() without reading it twice", () => {
    const reader = createClaudeDocReader();
    const record = user("u1", "one");
    reader.push(record);
    expect(reader.doc().items).toHaveLength(1);
    reader.push(`\n${user("u2", "two")}`);
    reader.push("\n");
    expect(reader.doc().items.map((i) => i.id)).toEqual(["u1:0", "u2:0"]);
  });

  it("does not re-join a growing partial line on each push", () => {
    const reader = createClaudeDocReader();
    const big = `{"type":"user","uuid":"b","message":{"content":"${"x".repeat(200_000)}`;
    const started = Date.now();
    for (let i = 0; i < 400; i++) reader.push(big.slice(i * 500, i * 500 + 500));
    expect(Date.now() - started).toBeLessThan(500);
    expect(reader.doc().items).toEqual([]);
  });
});

describe("parseClaudeDoc: a pending question or plan", () => {
  const ask = assistant("a", [
    toolUse("q1", "AskUserQuestion", {
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          multiSelect: true,
          options: [{ label: "A", description: "first" }, { label: "B" }],
        },
      ],
    }),
  ]);

  it("surfaces AskUserQuestion input while no result exists", () => {
    expect(parseClaudeDoc(ask).asking).toEqual({
      id: "q1",
      tool: "AskUserQuestion",
      questions: [
        {
          question: "Which one?",
          header: "Pick",
          multiSelect: true,
          options: [{ label: "A", description: "first" }, { label: "B" }],
        },
      ],
    });
  });

  it("surfaces an ExitPlanMode plan, and drops it once answered or moved on", () => {
    const plan = assistant("p", [toolUse("e1", "ExitPlanMode", { plan: "1. do it\u001b[0m" })]);
    expect(parseClaudeDoc(plan).asking).toEqual({
      id: "e1",
      tool: "ExitPlanMode",
      plan: "1. do it",
    });
    expect(
      parseClaudeDoc([plan, user("r", [toolResult("e1", "approved")])].join("\n")).asking,
    ).toBeUndefined();
    expect(parseClaudeDoc([ask, user("n", "never mind")].join("\n")).asking).toBeUndefined();
    expect(parseClaudeDoc(user("n", "hi")).asking).toBeUndefined();
  });
});

describe("parseClaudeDoc: question and plan tool rows", () => {
  it("names the question as the row's target and keeps the answer as its output", () => {
    const text = [
      assistant("a", [
        toolUse("q1", "AskUserQuestion", {
          questions: [{ question: "Which tests?", multiSelect: false, options: [{ label: "A" }] }],
        }),
      ]),
      user("r", [toolResult("q1", "User has answered: Which tests? = A")]),
    ].join("\n");
    const row = parseClaudeDoc(text).items.find((item) => item.kind === "tool");
    expect(row?.kind === "tool" && row.target).toBe("Which tests?");
    expect(row?.kind === "tool" && row.output).toContain("= A");
  });

  it("names the plan's first line (without heading marks) as the target", () => {
    const text = assistant("p", [
      toolUse("e1", "ExitPlanMode", { plan: "## Move the discount\n\n1. do it" }),
    ]);
    const row = parseClaudeDoc(text).items.find((item) => item.kind === "tool");
    expect(row?.kind === "tool" && row.target).toBe("Move the discount");
  });
});

describe("createClaudeDocReader", () => {
  const text = [
    user("u1", "one"),
    assistant("a1", [
      toolUse("t1", "Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }),
    ]),
    user("u2", [toolResult("t1", "ok")]),
    assistant("a2", [{ type: "text", text: "two" }]),
  ].join("\n");

  it("gives the same doc however the bytes are chunked, incl. a record split mid-way", () => {
    const whole = parseClaudeDoc(text);
    for (const size of [1, 7, 50, 1000]) {
      const reader = createClaudeDocReader();
      for (let i = 0; i < text.length; i += size) reader.push(text.slice(i, i + size));
      expect(reader.doc()).toEqual(whole);
    }
  });

  it("starts from a first partial line and feeds only new bytes", () => {
    const reader = createClaudeDocReader();
    reader.push(`ssage":"cut"}}\n${user("u1", "one")}\n`);
    expect(reader.doc().items.map((i) => i.id)).toEqual(["u1:0"]);
    reader.push(`${assistant("a1", [{ type: "text", text: "two" }])}\n`);
    expect(reader.doc().items.map((i) => i.id)).toEqual(["u1:0", "a1:0"]);
  });

  it("keeps the last items only, but todos, agents and files survive", () => {
    const reader = createClaudeDocReader({ maxItems: 5 });
    reader.push(
      `${assistant("a0", [
        toolUse("td", "TodoWrite", { todos: [{ content: "keep me", status: "pending" }] }),
        toolUse("sa", "Task", { description: "agent" }),
        toolUse("ed", "Edit", { file_path: "/w/z.ts", old_string: "a", new_string: "b" }),
      ])}\n`,
    );
    for (let i = 0; i < 40; i++) reader.push(`${user(`u${i}`, `m${i}`)}\n`);
    const doc = reader.doc();
    expect(doc.items.map((item) => item.id)).toEqual(["u35:0", "u36:0", "u37:0", "u38:0", "u39:0"]);
    expect(doc.todos).toEqual([{ text: "keep me", state: "open" }]);
    expect(doc.agents.map((a) => a.id)).toEqual(["sa"]);
    expect(doc.files).toEqual([{ path: "/w/z.ts", added: 1, removed: 1 }]);
  });

  it("returns an independent doc each call", () => {
    const reader = createClaudeDocReader();
    reader.push(`${user("u1", "one")}\n`);
    const first = reader.doc();
    reader.push(`${user("u2", "two")}\n`);
    expect(first.items).toHaveLength(1);
    expect(reader.doc().items).toHaveLength(2);
  });
});

describe("parseCopilotDoc", () => {
  const event = (type: string, data: Record<string, unknown>, id = "e"): string =>
    line({ id, timestamp: T0, parentId: null, type, data });

  it("reads messages in order, tool requests with command and path, and results", () => {
    const doc = parseCopilotDoc(
      [
        event("user.message", { content: " fix it " }, "e1"),
        event(
          "assistant.message",
          {
            content: "Looking.",
            model: "gpt-5",
            toolRequests: [
              { toolCallId: "c1", name: "bash", arguments: { command: "ls -la\npwd" } },
              {
                toolCallId: "c2",
                name: "view",
                arguments: JSON.stringify({ path: "/w/README.md" }),
              },
            ],
          },
          "e2",
        ),
        event(
          "tool.execution_complete",
          { toolCallId: "c1", success: true, result: { content: "files" } },
          "e3",
        ),
        event(
          "tool.execution_complete",
          { toolCallId: "c2", success: false, result: { content: "nope" } },
          "e4",
        ),
        event("assistant.message", { content: "Done." }, "e5"),
      ].join("\n"),
    );
    expect(doc.items.map((i) => i.id)).toEqual(["e1:0", "e2:0", "c1", "c2", "e5:0"]);
    expect(tools(doc)).toMatchObject([
      { tool: "bash", target: "ls -la", command: "ls -la\npwd", state: "ok", output: "files" },
      { tool: "view", target: "README.md", path: "/w/README.md", state: "error", output: "nope" },
    ]);
    expect(doc.model).toBe("gpt-5");
    expect(doc.todos).toBeUndefined();
    expect(doc.agents).toEqual([]);
  });

  it("skips injected, autopilot and sub-agent messages and a cut record", () => {
    const doc = parseCopilotDoc(
      [
        'ssage","data":{"content":"cut',
        event("user.message", { content: "skill", source: "x" }),
        event("user.message", { content: "go", isAutopilotContinuation: true }),
        event("assistant.message", { content: "sub", parentToolCallId: "t" }),
        event("user.message", { content: "real" }),
      ].join("\n"),
    );
    expect(doc.items.map((i) => (i.kind === "tool" || i.kind === "divider" ? "" : i.text))).toEqual(
      ["real"],
    );
  });

  it("is chunk independent and has the phone's turns", () => {
    const text = [
      event("user.message", { content: "a" }, "e1"),
      event("assistant.message", { content: "b", toolRequests: [{ name: "bash" }] }, "e2"),
    ].join("\n");
    const reader = createCopilotDocReader();
    for (let i = 0; i < text.length; i += 9) reader.push(text.slice(i, i + 9));
    expect(reader.doc()).toEqual(parseCopilotDoc(text));
    expect(parseCopilotChat(text).turns).toHaveLength(2);
  });
});

describe("parseCodexDoc", () => {
  const completed = (item: Record<string, unknown>, timestamp = T0): string =>
    line({ timestamp, type: "event_msg", payload: { type: "item_completed", item } });
  const message = (role: string, text: string): string =>
    line({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      },
    });

  it("reads messages, commands with output and exit state, and file changes", () => {
    const doc = parseCodexDoc(
      [
        line({ type: "turn_context", payload: { model: "gpt-5-codex" } }),
        completed({ type: "UserMessage", content: [{ type: "Text", text: "run the tests" }] }),
        completed({ type: "Reasoning", text: "secret" }),
        completed({
          type: "CommandExecution",
          id: "x1",
          command: ["bash", "-lc", "pnpm test\nsecond"],
          aggregated_output: "3 passed",
          exit_code: 0,
        }),
        completed({ type: "CommandExecution", id: "x2", command: "false", exit_code: 1 }),
        completed({
          type: "FileChange",
          changes: {
            "/w/a.ts": { unified_diff: "--- a\n+++ b\n@@\n-old\n+new\n+more\n" },
            "/w/b.ts": {},
          },
        }),
        completed({ type: "AgentMessage", content: [{ type: "Text", text: "All green." }] }),
        line({
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 4321 } } },
        }),
      ].join("\n"),
    );
    expect(doc.items.map((i) => i.kind)).toEqual(["user", "tool", "tool", "tool", "tool", "text"]);
    expect(tools(doc)[0]).toMatchObject({
      id: "x1",
      tool: "exec",
      target: "bash -lc pnpm test",
      command: "bash -lc pnpm test\nsecond",
      output: "3 passed",
      state: "ok",
    });
    expect(tools(doc)[1]?.state).toBe("error");
    expect(doc.files).toEqual([{ path: "/w/a.ts", added: 2, removed: 1 }, { path: "/w/b.ts" }]);
    expect(doc.model).toBe("gpt-5-codex");
    expect(doc.contextTokens).toBe(4321);
    expect(JSON.stringify(doc)).not.toContain("secret");
  });

  it("reads update_plan as the to-do list", () => {
    const doc = parseCodexDoc(
      line({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "update_plan",
          arguments: JSON.stringify({
            plan: [
              { step: "a", status: "completed" },
              { step: "b", status: "in_progress" },
              { step: "c", status: "pending" },
            ],
          }),
        },
      }),
    );
    expect(doc.todos).toEqual([
      { text: "a", state: "done" },
      { text: "b", state: "active" },
      { text: "c", state: "open" },
    ]);
  });

  it("falls back to response_item messages, dropping injected text, and is chunk independent", () => {
    const text = [
      message("developer", "system"),
      message("user", "<environment_context>cwd</environment_context>"),
      message("user", "hello"),
      message("assistant", "hi"),
    ].join("\n");
    const doc = parseCodexDoc(text);
    expect(doc.items.map((i) => (i.kind === "tool" || i.kind === "divider" ? "" : i.text))).toEqual(
      ["hello", "hi"],
    );
    const reader = createCodexDocReader();
    for (let i = 0; i < text.length; i += 11) reader.push(text.slice(i, i + 11));
    expect(reader.doc()).toEqual(doc);
    expect(parseCodexChat(text).turns).toHaveLength(2);
  });

  it("never throws on junk", () => {
    expect(parseCodexDoc("\u0000{[").items).toEqual([]);
  });
});
