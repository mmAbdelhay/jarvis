// The Chat view's markdown. It started as the phone's contract (apps/mobile chat-text.test.ts); the
// desktop now reads more (headings, nesting, tables, emphasis), so the old cases hold and new ones follow.
import { describe, expect, it } from "vitest";
import {
  type ChatBlock,
  type ChatInline,
  filePathOf,
  isHttpsUrl,
  linkParts,
  parseChatText,
  pathLabel,
} from "./agent-chat-text.js";

describe("parseChatText", () => {
  it("bold, code and text inlines", () => {
    expect(parseChatText("a **b** `c` d")).toEqual([
      {
        kind: "para",
        inlines: [
          { kind: "text", text: "a " },
          { kind: "bold", children: [{ kind: "text", text: "b" }] },
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
          {
            marker: "2.",
            inlines: [{ kind: "bold", children: [{ kind: "text", text: "two" }] }],
          },
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
      { kind: "codeBlock", text: "const x = `**`;", lang: "ts" },
    ]);
  });
  it("a fence with no language has no lang", () => {
    expect(parseChatText("```\nplain\n```")).toEqual([{ kind: "codeBlock", text: "plain" }]);
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

const text = (value: string): ChatInline => ({ kind: "text", text: value });
const only = (source: string): ChatBlock => {
  const blocks = parseChatText(source);
  expect(blocks).toHaveLength(1);
  return blocks[0] as ChatBlock;
};
const inlinesOf = (source: string): ChatInline[] => {
  const block = only(source);
  if (block.kind !== "para") throw new Error(`not a paragraph: ${block.kind}`);
  return block.inlines;
};

describe("headings and rules", () => {
  it("reads # to ###### with a level", () => {
    for (let level = 1; level <= 6; level++) {
      expect(only(`${"#".repeat(level)} Title`)).toEqual({
        kind: "heading",
        level,
        inlines: [text("Title")],
      });
    }
  });
  it("is not a heading without a space, past six, or in the middle of a word", () => {
    expect(only("#hashtag").kind).toBe("para");
    expect(only("####### seven").kind).toBe("para");
    expect(only("#").kind).toBe("para");
  });
  it("drops a closing run of #", () => {
    expect(only("## Done ##")).toEqual({ kind: "heading", level: 2, inlines: [text("Done")] });
  });
  it("draws a horizontal rule for ---, *** and ___", () => {
    for (const rule of ["---", "***", "___", "- - -", "  ----"]) {
      expect(only(rule)).toEqual({ kind: "rule" });
    }
    expect(only("--").kind).toBe("para");
  });
});

describe("emphasis", () => {
  it("reads italics with * and _", () => {
    expect(inlinesOf("a *b* and _c_")).toEqual([
      text("a "),
      { kind: "italic", children: [text("b")] },
      text(" and "),
      { kind: "italic", children: [text("c")] },
    ]);
  });
  it("never reads _ inside a word as italics", () => {
    expect(inlinesOf("snake_case and file_names_here.ts")).toEqual([
      text("snake_case and file_names_here.ts"),
    ]);
  });
  it("reads bold italic, strikethrough and nested inlines", () => {
    expect(inlinesOf("***x***")).toEqual([
      { kind: "italic", children: [{ kind: "bold", children: [text("x")] }] },
    ]);
    expect(inlinesOf("~~gone~~")).toEqual([{ kind: "strike", children: [text("gone")] }]);
    expect(inlinesOf("**run `npm test` or [docs](https://a.io/x)**")).toEqual([
      {
        kind: "bold",
        children: [
          text("run "),
          { kind: "code", text: "npm test" },
          text(" or "),
          { kind: "link", text: "docs", url: "https://a.io/x" },
        ],
      },
    ]);
  });
  it("keeps a bare link out of its closing marker", () => {
    expect(inlinesOf("**see https://claude.ai/x**")).toEqual([
      {
        kind: "bold",
        children: [
          text("see "),
          { kind: "link", text: "https://claude.ai/x", url: "https://claude.ai/x" },
        ],
      },
    ]);
  });
  it("leaves unclosed and spaced markers as text, like a streaming reply", () => {
    expect(inlinesOf("*a b")).toEqual([text("*a b")]);
    expect(inlinesOf("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
    expect(inlinesOf("**bold and *half")).toEqual([text("**bold and *half")]);
    expect(inlinesOf("~~x")).toEqual([text("~~x")]);
    expect(inlinesOf("a ~ b ~ c")).toEqual([text("a ~ b ~ c")]);
  });
  it("keeps inline code literal", () => {
    expect(inlinesOf("`*a* _b_ **c**`")).toEqual([{ kind: "code", text: "*a* _b_ **c**" }]);
  });
  it("stops emphasis at a line break", () => {
    expect(inlinesOf("*a\nb*")).toEqual([text("*a\nb*")]);
  });
});

describe("lists", () => {
  it("nests lists by indent, and continuation lines stay in their item", () => {
    const block = only("1. one\n   more of one\n   - sub a\n   - sub b\n2. two");
    expect(block).toMatchObject({ kind: "list", ordered: true });
    const list = block as Extract<ChatBlock, { kind: "list" }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.inlines).toEqual([text("one\nmore of one")]);
    expect(list.items[0]?.children).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { marker: "•", inlines: [text("sub a")] },
          { marker: "•", inlines: [text("sub b")] },
        ],
      },
    ]);
    expect(list.items[1]?.children).toBeUndefined();
  });
  it("nests with two spaces or a tab", () => {
    for (const nested of ["- a\n  - b", "- a\n\t- b"]) {
      const list = only(nested) as Extract<ChatBlock, { kind: "list" }>;
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.children?.[0]).toMatchObject({ kind: "list" });
    }
  });
  it("keeps a numbered list together across blank lines", () => {
    const list = only("1. a\n\n2. b\n\n3. c") as Extract<ChatBlock, { kind: "list" }>;
    expect(list.items.map((item) => item.marker)).toEqual(["1.", "2.", "3."]);
  });
  it("reads task items", () => {
    const list = only("- [ ] todo\n- [x] done\n- [X] also\n- [y] no") as Extract<
      ChatBlock,
      { kind: "list" }
    >;
    expect(list.items.map((item) => item.checked)).toEqual([false, true, true, undefined]);
    expect(list.items[0]?.inlines).toEqual([text("todo")]);
    expect(list.items[3]?.inlines).toEqual([text("[y] no")]);
  });
  it("holds a fence inside an item, whatever its indent", () => {
    const list = only("1. run:\n   ```sh\n   npm test\n\n   done\n   ```\n2. next") as Extract<
      ChatBlock,
      { kind: "list" }
    >;
    expect(list.items[0]?.children).toEqual([
      { kind: "codeBlock", text: "npm test\n\ndone", lang: "sh" },
    ]);
    expect(list.items).toHaveLength(2);
  });
  it("stops nesting at the depth cap and stays text", () => {
    const deep = `${"- ".repeat(30)}x`;
    let depth = 0;
    let block: ChatBlock | undefined = only(deep);
    while (block?.kind === "list") {
      depth++;
      block = block.items[0]?.children?.[0];
    }
    expect(depth).toBeLessThanOrEqual(9);
  });
});

describe("quotes, tables and fences", () => {
  it("reads blockquotes with their own blocks", () => {
    expect(only("> a **b**\n> - c")).toEqual({
      kind: "quote",
      blocks: [
        { kind: "para", inlines: [text("a "), { kind: "bold", children: [text("b")] }] },
        { kind: "list", ordered: false, items: [{ marker: "•", inlines: [text("c")] }] },
      ],
    });
  });
  it("reads tables with alignment, inline formatting and escaped pipes", () => {
    expect(
      only("| Name | Qty | Note |\n|:--|--:|:-:|\n| `a` | 1 | x \\| y |\n| **b** | 2 |"),
    ).toEqual({
      kind: "table",
      align: ["left", "right", "center"],
      head: [[text("Name")], [text("Qty")], [text("Note")]],
      rows: [
        [[{ kind: "code", text: "a" }], [text("1")], [text("x | y")]],
        [[{ kind: "bold", children: [text("b")] }], [text("2")], []],
      ],
    });
  });
  it("is not a table without a delimiter row", () => {
    expect(only("a | b\nc | d").kind).toBe("para");
  });
  it("opens fences of ~~~ and of more than three backticks, and closes on a match", () => {
    expect(only("~~~py\nx = 1\n~~~")).toEqual({ kind: "codeBlock", text: "x = 1", lang: "py" });
    expect(only("````md\n```\ninner\n```\n````")).toEqual({
      kind: "codeBlock",
      text: "```\ninner\n```",
      lang: "md",
    });
  });
  it("keeps an unclosed fence open to the end", () => {
    expect(only("```ts\nlet a")).toEqual({ kind: "codeBlock", text: "let a", lang: "ts" });
  });
});

describe("file paths", () => {
  it("knows a path with an optional :line, and nothing else", () => {
    expect(filePathOf("src/a/b.ts:12", { code: true })).toEqual({ path: "src/a/b.ts", line: 12 });
    expect(filePathOf("/Users/me/x.pdf", { code: true })).toEqual({ path: "/Users/me/x.pdf" });
    expect(filePathOf("./run.sh", { code: true })).toEqual({ path: "./run.sh" });
    expect(filePathOf("~/notes/a.md", { code: true })).toEqual({ path: "~/notes/a.md" });
    expect(filePathOf("package.json", { code: true })).toEqual({ path: "package.json" });
    for (const not of [
      "npm run x/y",
      "https://a.com/x.js",
      "origin/master",
      "and/or",
      "/clear",
      "Math.floor",
      "a/b",
      "x.y/z",
      "1.5/2.0",
      "C:\\x.ts",
      "",
    ]) {
      expect(filePathOf(not, { code: true })).toBeUndefined();
    }
  });
  it("finds a plain-text path only when it is unambiguous", () => {
    expect(filePathOf("package.json", { code: false })).toBeUndefined();
    expect(filePathOf("src/a.ts", { code: false })).toEqual({ path: "src/a.ts" });
    expect(filePathOf("e.g.", { code: false })).toBeUndefined();
  });
  it("turns a code span and a plain token into path inlines", () => {
    expect(inlinesOf("see `src/a.ts:3` and src/b.ts, or and/or")).toEqual([
      text("see "),
      { kind: "path", text: "src/a.ts:3", path: "src/a.ts", line: 3, code: true },
      text(" and "),
      { kind: "path", text: "src/b.ts", path: "src/b.ts", code: false },
      text(", or and/or"),
    ]);
  });
  it("shortens a long path from the front, keeping the file name", () => {
    expect(pathLabel("src/a.ts")).toBe("src/a.ts");
    const long = "/Users/someone/projects/jarvis/packages/desktop/renderer/agent-chat/code.ts";
    const label = pathLabel(long);
    expect(label.startsWith("…/")).toBe(true);
    expect(label.endsWith("code.ts")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(40);
    const huge = pathLabel(`a/${"x".repeat(100)}.ts`);
    expect(huge.length).toBeLessThanOrEqual(40);
    expect(huge).toContain("…");
  });
});

describe("linear time", () => {
  it("parses 200 KB of pathological input quickly", () => {
    const inputs = [
      "*a ".repeat(70_000),
      "_a".repeat(100_000),
      "[".repeat(200_000),
      "[a](https://".repeat(16_000),
      "`a ".repeat(70_000),
      "**".repeat(100_000),
      "~~x ".repeat(50_000),
      "> ".repeat(100_000),
      "- ".repeat(100_000),
      "- a\n".repeat(50_000),
      "|a".repeat(100_000),
      `${"| a ".repeat(40_000)}\n${"|---".repeat(40_000)}`,
      `${"))))".repeat(50_000)}x`,
      `${"a/b.c ".repeat(30_000)}`,
      "# ".repeat(100_000),
      "1. a\n   ".repeat(25_000),
      "```\n".repeat(50_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      parseChatText(input);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});
