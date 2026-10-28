// Contract for the phone chat view's light markdown tokens.
import { describe, expect, it } from "vitest";
import { parseChatText } from "./chat-text";

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
});
