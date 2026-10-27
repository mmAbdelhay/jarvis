import { describe, expect, it } from "vitest";
import {
  answerNoticeKey,
  CLAUDE_CHAT_KEYS,
  chatFeed,
  chatHeader,
  linkParts,
  meterWidth,
  modeKey,
  toolText,
} from "./claude-chat";

describe("claude chat model", () => {
  it("feed is newest first: working, then the last turn's text after its tools", () => {
    const feed = chatFeed({
      kind: "claude",
      sessionId: "s",
      turns: [
        { role: "user", text: "fix it", tools: [] },
        {
          role: "assistant",
          text: "Done.",
          tools: [{ name: "Edit", target: "a.ts", added: 6, removed: 2 }],
        },
      ],
      working: "✻ Crunching… 5m",
    });
    expect(feed.map((item) => item.kind)).toEqual(["working", "text", "tool", "user"]);
    expect(new Set(feed.map((item) => item.key)).size).toBe(feed.length);
  });

  it("an assistant turn with no text shows only its tools; none view is empty", () => {
    expect(
      chatFeed({
        kind: "claude",
        sessionId: "s",
        turns: [{ role: "assistant", text: "  ", tools: [{ name: "Read" }] }],
      }).map((item) => item.kind),
    ).toEqual(["tool"]);
    expect(chatFeed({ kind: "none" })).toEqual([]);
  });

  it("header: Claude's title, else the pane key; project · Claude Code", () => {
    const view = { kind: "claude" as const, sessionId: "s", turns: [], title: "metric colors" };
    expect(chatHeader(view, "p1", "jarvis")).toEqual({
      title: "metric colors",
      subtitle: "jarvis · Claude Code",
    });
    expect(chatHeader({ ...view, title: " " }, "p1", undefined)).toEqual({
      title: "p1",
      subtitle: "Claude Code",
    });
  });

  it("link text that differs from the host shows the host too", () => {
    expect(linkParts("canvas", "https://claude.ai/a")).toEqual({
      text: "canvas",
      host: "claude.ai",
    });
    expect(linkParts("https://claude.ai/a", "https://claude.ai/a")).toEqual({
      text: "claude.ai/a",
    });
    expect(linkParts("evil.example", "https://evil.example/x")).toEqual({
      text: "evil.example/x",
    });
  });

  it("a host hidden behind credentials or other leading text is always shown", () => {
    expect(linkParts("https://google.com@evil.com/", "https://google.com@evil.com/")).toEqual({
      text: "google.com@evil.com",
      host: "evil.com",
    });
    // Text equal to the host shows the whole address, credentials included.
    expect(linkParts("google.com", "https://user:pw@google.com/")).toEqual({
      text: "user:pw@google.com",
      host: "google.com",
    });
    expect(linkParts("claude.ai/docs", "https://claude.ai/docs")).toEqual({
      text: "claude.ai/docs",
    });
    expect(linkParts("claude.ai.evil.com", "https://claude.ai.evil.com/x")).toEqual({
      text: "claude.ai.evil.com/x",
    });
    expect(linkParts("claude.ai", "https://evil.com/")).toEqual({
      text: "claude.ai",
      host: "evil.com",
    });
  });

  it("chat keys: one-tap interrupt, no Tab, no Ctrl latch", () => {
    expect(CLAUDE_CHAT_KEYS).toEqual(["esc", "shiftTab", "ctrlC", "up", "down"]);
  });

  it("modes, tools, meters and answer notices", () => {
    expect(modeKey(undefined)).toBe("claude.mode.default");
    expect(modeKey("acceptEdits")).toBe("claude.mode.acceptEdits");
    expect(toolText({ name: "Edit", target: "a.ts" })).toBe("Edit a.ts");
    expect(toolText({ name: "Bash" })).toBe("Bash");
    expect(meterWidth(140)).toBe(100);
    expect(meterWidth(-3)).toBe(0);
    expect(meterWidth(22.4)).toBe(22);
    expect(answerNoticeKey({ ok: false, reason: "changed" })).toBe("claude.answerChanged");
    expect(answerNoticeKey({ ok: false, reason: "gone" })).toBe("claude.answerGone");
    expect(answerNoticeKey({ ok: true })).toBeUndefined();
  });
});
