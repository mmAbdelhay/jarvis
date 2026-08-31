import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown.js";

const text = (value: string) => ({ kind: "text", text: value });

describe("parseMarkdown — blocks", () => {
  it("returns nothing for an empty document", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("parses a heading with its level", () => {
    expect(parseMarkdown("## Release notes")).toEqual([
      { kind: "heading", level: 2, children: [text("Release notes")] },
    ]);
  });

  it("parses every heading level", () => {
    const levels = parseMarkdown("# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f").map(
      (block) => (block.kind === "heading" ? block.level : undefined),
    );
    expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("parses a paragraph", () => {
    expect(parseMarkdown("Just a line.")).toEqual([
      { kind: "paragraph", children: [text("Just a line.")] },
    ]);
  });

  it("parses a fenced code block with its language", () => {
    expect(parseMarkdown("```ts\nconst x = 1;\n```")).toEqual([
      { kind: "code", language: "ts", text: "const x = 1;\n" },
    ]);
  });

  it("parses a fence with no language as an empty language", () => {
    expect(parseMarkdown("```\nplain\n```")).toEqual([
      { kind: "code", language: "", text: "plain\n" },
    ]);
  });

  it("parses an indented code block", () => {
    expect(parseMarkdown("    indented\n")).toEqual([
      { kind: "code", language: "", text: "indented\n" },
    ]);
  });

  it("parses a horizontal rule", () => {
    expect(parseMarkdown("---")).toEqual([{ kind: "rule" }]);
  });

  it("keeps blocks in document order", () => {
    const kinds = parseMarkdown("# t\n\npara\n\n```\nc\n```\n\n---").map((block) => block.kind);
    expect(kinds).toEqual(["heading", "paragraph", "code", "rule"]);
  });
});

describe("parseMarkdown — inlines", () => {
  it("parses emphasis", () => {
    expect(parseMarkdown("an *emphatic* word")).toEqual([
      {
        kind: "paragraph",
        children: [text("an "), { kind: "emphasis", children: [text("emphatic")] }, text(" word")],
      },
    ]);
  });

  it("parses strong", () => {
    expect(parseMarkdown("**loud**")).toEqual([
      { kind: "paragraph", children: [{ kind: "strong", children: [text("loud")] }] },
    ]);
  });

  it("parses inline code", () => {
    expect(parseMarkdown("call `run()` now")).toEqual([
      {
        kind: "paragraph",
        children: [text("call "), { kind: "code", text: "run()" }, text(" now")],
      },
    ]);
  });

  it("parses a link with its href", () => {
    expect(parseMarkdown("[docs](https://example.com/docs)")).toEqual([
      {
        kind: "paragraph",
        children: [{ kind: "link", href: "https://example.com/docs", children: [text("docs")] }],
      },
    ]);
  });

  it("keeps a relative link", () => {
    expect(parseMarkdown("[next](./other.md)")).toEqual([
      {
        kind: "paragraph",
        children: [{ kind: "link", href: "./other.md", children: [text("next")] }],
      },
    ]);
  });

  // The security case: an agent writes the document, and its link text must
  // never become an executable href in the renderer.
  //
  // markdown-it's own validateLink already refuses javascript:, file: and
  // data:, emitting the literal source text instead of a link — so these two
  // cases never reach our gate. They are pinned anyway: the guarantee the
  // renderer depends on is "no link node", and it must hold whichever layer
  // enforces it.
  it.each(["[click me](javascript:alert)", "[secrets](file:///etc/passwd)", "[x](data:text/html,y)"])(
    "produces no link node for %s",
    (source) => {
      const kinds = parseMarkdown(source).flatMap((block) =>
        block.kind === "paragraph" ? block.children.map((child) => child.kind) : [],
      );
      expect(kinds).not.toContain("link");
    },
  );

  // This is the case our own gate exists for: markdown-it permits mailto:,
  // and a hosted view has no business being handed one.
  it("strips a scheme markdown-it allows but the workspace does not", () => {
    expect(parseMarkdown("[mail me](mailto:a@example.com)")).toEqual([
      { kind: "paragraph", children: [text("mail me")] },
    ]);
  });

  // Raw HTML in the source must not survive as markup. markdown-it is
  // configured with html:false, so a tag arrives as ordinary characters in a
  // text node — the renderer then sets it with textContent and it shows up
  // on screen as the literal string it is.
  it("keeps raw HTML as literal text", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "paragraph", children: [text("<img src=x onerror=alert(1)>")] },
    ]);
  });

  it("turns a soft line break into a space", () => {
    expect(parseMarkdown("one\ntwo")).toEqual([
      { kind: "paragraph", children: [text("one"), text(" "), text("two")] },
    ]);
  });

  it("parses nested strong inside emphasis", () => {
    expect(parseMarkdown("*a **b** c*")).toEqual([
      {
        kind: "paragraph",
        children: [
          {
            kind: "emphasis",
            children: [text("a "), { kind: "strong", children: [text("b")] }, text(" c")],
          },
        ],
      },
    ]);
  });

  it("preserves Arabic text unchanged", () => {
    expect(parseMarkdown("تقرير الأخطاء")).toEqual([
      { kind: "paragraph", children: [text("تقرير الأخطاء")] },
    ]);
  });
});
