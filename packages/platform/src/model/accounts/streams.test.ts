import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClaudeStream } from "./stream-claude.js";
import { createCodexStream } from "./stream-codex.js";
import type { CliStreamEvent, CliStreamParser } from "./stream-types.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);

export function play(
  parser: CliStreamParser,
  lines: string[],
  exitCode: number | null = 0,
  stderr = "",
): CliStreamEvent[] {
  const out: CliStreamEvent[] = [];
  for (const line of lines) {
    const events = parser.line(line);
    out.push(...events);
    if (events.some((e) => e.kind === "tripwire")) return out;
  }
  out.push(...parser.end(exitCode, stderr));
  return out;
}

const text = (events: CliStreamEvent[]) =>
  events.flatMap((e) => (e.kind === "text" ? [e.text] : [])).join("");

describe("Claude stream-json", () => {
  it("collects the reply, progress and usage", () => {
    const events = play(createClaudeStream(), fixture("claude-reply"));
    expect(events[0]).toEqual({ kind: "progress" });
    expect(text(events)).toContain("```jarvis-tool 0123456789abcdef");
    expect(events).toContainEqual({ kind: "usage", inputTokens: 812, outputTokens: 41 });
    expect(events.some((e) => e.kind === "error" || e.kind === "tripwire")).toBe(false);
  });

  it("trips when system/init lists any tool", () => {
    const events = play(createClaudeStream(), fixture("claude-init-tools"));
    expect(events).toEqual([
      { kind: "tripwire", reason: "claude offered its own tools: Bash, Read, WebFetch" },
    ]);
  });

  it("trips on a tool_use block", () => {
    const events = play(createClaudeStream(), fixture("claude-tool-use"));
    expect(events.at(-1)).toEqual({
      kind: "tripwire",
      reason: "claude asked for its own tool Bash",
    });
    expect(text(events)).toBe("");
  });

  it("reports a missing login as not-signed-in before any progress", () => {
    const events = play(createClaudeStream(), fixture("claude-not-signed-in"));
    expect(events.find((e) => e.kind === "progress")).toBeUndefined();
    expect(events).toContainEqual({
      kind: "error",
      code: "not-signed-in",
      detail: "Not logged in · Please run /login",
    });
  });

  it("turns a silent crash into an error from stderr", () => {
    const events = play(
      createClaudeStream(),
      [],
      1,
      "Error: getaddrinfo ENOTFOUND api.anthropic.com",
    );
    expect(events).toEqual([
      {
        kind: "error",
        code: "unavailable",
        detail: "Error: getaddrinfo ENOTFOUND api.anthropic.com",
      },
    ]);
  });

  it("ignores lines that are not JSON", () => {
    expect(createClaudeStream().line("warning: something")).toEqual([]);
  });
});

describe("Codex exec --json", () => {
  it("collects the agent message", () => {
    const events = play(createCodexStream(), fixture("codex-reply"));
    expect(events[0]).toEqual({ kind: "progress" });
    expect(text(events)).toBe(
      'Searching.\n```jarvis-tool 0123456789abcdef\n{"name":"pkg_search","input":{"query":"gimp"}}\n```',
    );
    expect(events).toContainEqual({ kind: "usage", inputTokens: 2763, outputTokens: 52 });
  });

  it("trips on the first command_execution item, before it completes", () => {
    const events = play(createCodexStream(), fixture("codex-command"));
    expect(events.at(-1)).toEqual({
      kind: "tripwire",
      reason: "chatgpt started its own tool (command_execution)",
    });
    expect(events.filter((e) => e.kind === "tripwire")).toHaveLength(1);
  });

  it("trips on a file change", () => {
    expect(play(createCodexStream(), fixture("codex-file-change")).at(-1)).toEqual({
      kind: "tripwire",
      reason: "chatgpt started its own tool (file_change)",
    });
  });

  it("maps an expired token to not-signed-in", () => {
    const events = play(createCodexStream(), fixture("codex-auth-failed"), 1);
    expect(events).toContainEqual({
      kind: "error",
      code: "not-signed-in",
      detail:
        "unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again.",
    });
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
  });

  it("reports a rate limit", () => {
    const events = play(
      createCodexStream(),
      ['{"type":"turn.failed","error":{"message":"429 Too Many Requests: usage limit reached"}}'],
      1,
    );
    expect(events[0]).toEqual({
      kind: "error",
      code: "rate-limit",
      detail: "429 Too Many Requests: usage limit reached",
    });
  });
});
