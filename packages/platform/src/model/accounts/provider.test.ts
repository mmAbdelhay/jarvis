import { readFileSync } from "node:fs";
import { type ModelEvent, ProviderError } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import {
  type AccountProviderTexts,
  type AccountReadiness,
  createAccountProvider,
} from "./provider.js";
import type { CliProcess } from "./runner.js";
import { accountPaths, type CliInvocation, parseAccountPins } from "./specs.js";

const PINS = parseAccountPins(
  JSON.parse(
    readFileSync(new URL("../../../../../os/models/accounts.json", import.meta.url), "utf8"),
  ),
);
const lines = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);
const TEXTS: AccountProviderTexts = {
  notInstalled: (label) => `${label} is not installed`,
  signIn: (label) => `Sign in to ${label} again`,
  rateLimited: (label) => `${label} is busy`,
  unreachable: (label) => `${label} is unreachable`,
  failed: (label, detail) => `${label} failed: ${detail}`,
  tripwire: (label) => `${label} tried to use its own tools; Jarvis stopped it.`,
  sandboxOff: () => "no sandbox",
};

function fakeSpawn(script: string[], seen: CliInvocation[] = []) {
  return async (inv: CliInvocation): Promise<CliProcess> => {
    seen.push(inv);
    return {
      lines: (async function* () {
        yield* script;
      })(),
      exit: Promise.resolve(0),
      stderrTail: () => "",
      kill: async () => {},
    };
  };
}

function provider(
  account: "claude" | "chatgpt",
  script: string[],
  seen: CliInvocation[] = [],
  readiness: AccountReadiness = "ready",
) {
  return createAccountProvider({
    pin: PINS[account],
    model: "default",
    paths: accountPaths("/home/rafiq", account),
    spawn: fakeSpawn(script, seen),
    nonce: () => "0123456789abcdef",
    texts: TEXTS,
    readiness: async () => readiness,
  });
}

const TOOLS = [{ name: "pkg_search", description: "Search apps", inputSchema: { type: "object" } }];
async function drain(gen: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}
const request = (extra: object = {}) => ({
  system: "You are Jarvis.",
  messages: [{ role: "user" as const, text: "find gimp" }],
  tools: TOOLS,
  signal: new AbortController().signal,
  ...extra,
});

describe("account provider", () => {
  it("turns a fenced block into a tool call, after an empty first event", async () => {
    const seen: CliInvocation[] = [];
    const events = await drain(provider("claude", lines("claude-reply"), seen).chat(request()));
    expect(events).toEqual([
      { type: "text", delta: "" },
      { type: "text", delta: "Let me look." },
      { type: "tool_call", id: "claude-1", name: "pkg_search", input: { query: "gimp" } },
      { type: "done", usage: { inputTokens: 812, outputTokens: 41 } },
    ]);
    expect(seen[0]?.stdin).toContain("```jarvis-tool 0123456789abcdef");
    expect(seen[0]?.stdin).toContain("- pkg_search: Search apps");
  });

  it("maps a not-signed-in CLI answer to ProviderError auth with the sign-in text", async () => {
    const run = drain(provider("claude", lines("claude-not-signed-in")).chat(request()));
    await expect(run).rejects.toEqual(new ProviderError("auth", "Sign in to Claude again"));
  });

  it("stops at the tripwire with a plain message", async () => {
    await expect(
      drain(provider("claude", lines("claude-tool-use")).chat(request())),
    ).rejects.toEqual(
      new ProviderError("tripwire", "Claude tried to use its own tools; Jarvis stopped it."),
    );
  });

  it("refuses before starting anything when the CLI is not installed or signed out", async () => {
    const seen: CliInvocation[] = [];
    await expect(
      drain(provider("chatgpt", [], seen, "not-installed").chat(request())),
    ).rejects.toEqual(new ProviderError("auth", "ChatGPT is not installed"));
    await expect(
      drain(provider("chatgpt", [], seen, "signed-out").chat(request())),
    ).rejects.toEqual(new ProviderError("auth", "Sign in to ChatGPT again"));
    expect(seen).toEqual([]);
  });

  it("offers no tools and runs none in the final step-limit request", async () => {
    const seen: CliInvocation[] = [];
    const events = await drain(
      provider("chatgpt", lines("codex-reply"), seen).chat(request({ final: true })),
    );
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(seen[0]?.stdin).toContain("Answer in words only.");
  });

  it("attaches the newest screenshot for Claude only", async () => {
    const image = { mediaType: "image/png" as const, dataBase64: "iVBORw0K" };
    const messages = [
      { role: "user" as const, text: "look" },
      {
        role: "assistant" as const,
        text: "",
        toolCalls: [{ id: "c", name: "screen_look", input: {} }],
      },
      {
        role: "tool" as const,
        results: [{ callId: "c", name: "screen_look", content: "ok", isError: false, image }],
      },
    ];
    const claudeSeen: CliInvocation[] = [];
    await drain(provider("claude", lines("claude-reply"), claudeSeen).chat(request({ messages })));
    expect(claudeSeen[0]?.stdin).toContain('"type":"image"');
    const codexSeen: CliInvocation[] = [];
    await drain(provider("chatgpt", lines("codex-reply"), codexSeen).chat(request({ messages })));
    expect(codexSeen[0]?.stdin).not.toContain("iVBORw0K");
  });

  it("probes with one tiny prompt and lists the pinned models", async () => {
    expect(await provider("chatgpt", lines("codex-reply")).probe()).toEqual({
      ok: true,
      supportsTools: true,
      models: ["default", "gpt-5.5", "gpt-5.5-codex"],
    });
    expect(await provider("claude", lines("claude-not-signed-in")).probe()).toEqual({
      ok: false,
      supportsTools: false,
      models: ["default", "sonnet", "opus", "haiku"],
      error: "Sign in to Claude again",
    });
  });

  it("is reachable only when ready", async () => {
    expect(await provider("claude", []).reachable()).toEqual({ ok: true });
    expect(await provider("claude", [], [], "no-sandbox").reachable()).toEqual({
      ok: false,
      error: "no sandbox",
    });
  });
});
