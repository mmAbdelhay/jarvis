// The Chat view's light markdown: the phone's contract (apps/mobile chat-text.test.ts), kept rule for rule.
import { describe, expect, it } from "vitest";
import { isHttpsUrl, linkParts, parseChatText } from "./agent-chat-text.js";

describe("parseChatText", () => {
  it("bold, code and text inlines", () => {
    expect(parseChatText("a **b** `c` d")).toEqual([
      {
        kind: "para",
        inlines: [
          { kind: "text", text: "a " },
          { kind: "bold", text: "b" },
          { kind: "text", text: " " },
          { kind: "code", text: "c" },
          { kind: "text", text: " d" },
        ],
      },
    ]);
  });
  it("numbered and bulleted lists", () => {
    expect(parseChatText("1. one\n2. **two**")).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          { marker: "1.", inlines: [{ kind: "text", text: "one" }] },
          { marker: "2.", inlines: [{ kind: "bold", text: "two" }] },
        ],
      },
    ]);
    expect(parseChatText("- a\n* b")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { marker: "•", inlines: [{ kind: "text", text: "a" }] },
          { marker: "•", inlines: [{ kind: "text", text: "b" }] },
        ],
      },
    ]);
  });
  it("fenced code block kept raw", () => {
    expect(parseChatText("```ts\nconst x = `**`;\n```")).toEqual([
      { kind: "codeBlock", text: "const x = `**`;" },
    ]);
  });
  it("bare https link trims trailing punctuation", () => {
    expect(parseChatText("see https://claude.ai/x.")).toEqual([
      {
        kind: "para",
        inlines: [
          { kind: "text", text: "see " },
          { kind: "link", text: "https://claude.ai/x", url: "https://claude.ai/x" },
          { kind: "text", text: "." },
        ],
      },
    ]);
  });
  it("markdown link with https", () => {
    expect(parseChatText("[canvas](https://claude.ai/a)")).toEqual([
      { kind: "para", inlines: [{ kind: "link", text: "canvas", url: "https://claude.ai/a" }] },
    ]);
  });
  it("javascript: and http: are not links", () => {
    const text = "javascript:alert(1) http://example.com [x](file:/a) data:text/plain,hi";
    expect(parseChatText(text)).toEqual([{ kind: "para", inlines: [{ kind: "text", text }] }]);
  });
  it("unclosed markers stay literal", () => {
    expect(parseChatText("**a `b")).toEqual([
      { kind: "para", inlines: [{ kind: "text", text: "**a `b" }] },
    ]);
  });
  it("empty input", () => {
    expect(parseChatText("")).toEqual([]);
  });
  it("preserves paragraph newlines and splits blocks", () => {
    expect(parseChatText("a\nb\n \nc\n- d\n1. e")).toEqual([
      { kind: "para", inlines: [{ kind: "text", text: "a\nb" }] },
      { kind: "para", inlines: [{ kind: "text", text: "c" }] },
      {
        kind: "list",
        ordered: false,
        items: [{ marker: "•", inlines: [{ kind: "text", text: "d" }] }],
      },
      {
        kind: "list",
        ordered: true,
        items: [{ marker: "1.", inlines: [{ kind: "text", text: "e" }] }],
      },
    ]);
  });
  it("keeps code opaque and delimiters on the same line", () => {
    expect(parseChatText("`**x** https://a`\n**x\ny**")).toEqual([
      {
        kind: "para",
        inlines: [
          { kind: "code", text: "**x** https://a" },
          { kind: "text", text: "\n**x\ny**" },
        ],
      },
    ]);
  });
  it("requires single backticks and non-empty bold", () => {
    expect(parseChatText("``x`` ****")).toEqual([
      { kind: "para", inlines: [{ kind: "text", text: "``x`` ****" }] },
    ]);
  });
  it("labels a link by its real host", () => {
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
    expect(linkParts("google.com", "https://user:pw@google.com/")).toEqual({
      text: "user:pw@google.com",
      host: "google.com",
    });
    expect(linkParts("https://google.com@evil.com/", "https://google.com@evil.com/")).toEqual({
      text: "google.com@evil.com",
      host: "evil.com",
    });
    expect(linkParts("google.com", "https://evil.com/")).toEqual({
      text: "google.com",
      host: "evil.com",
    });
    expect(linkParts("x", "not a url")).toEqual({ text: "not a url" });
  });
  it("opens https only", () => {
    expect(isHttpsUrl("https://a.b/c")).toBe(true);
    for (const url of [
      "http://a.b",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "",
    ]) {
      expect(isHttpsUrl(url)).toBe(false);
    }
  });
});
