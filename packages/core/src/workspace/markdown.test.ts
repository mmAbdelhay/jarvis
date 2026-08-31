import { describe, expect, it } from "vitest";
import { findTaskMarkerOffsets, parseMarkdown } from "./markdown.js";

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

describe("parseMarkdown — nested blocks", () => {
  it("parses a bullet list", () => {
    expect(parseMarkdown("- one\n- two")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ kind: "paragraph", children: [text("one")] }],
          [{ kind: "paragraph", children: [text("two")] }],
        ],
      },
    ]);
  });

  it("parses an ordered list", () => {
    expect(parseMarkdown("1. first\n2. second")).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          [{ kind: "paragraph", children: [text("first")] }],
          [{ kind: "paragraph", children: [text("second")] }],
        ],
      },
    ]);
  });

  it("parses a list item holding more than one block", () => {
    expect(parseMarkdown("- one\n\n  ```\n  code\n  ```")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [
            { kind: "paragraph", children: [text("one")] },
            { kind: "code", language: "", text: "code\n" },
          ],
        ],
      },
    ]);
  });

  it("parses a nested list inside an item", () => {
    expect(parseMarkdown("- outer\n  - inner")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [
            { kind: "paragraph", children: [text("outer")] },
            {
              kind: "list",
              ordered: false,
              items: [[{ kind: "paragraph", children: [text("inner")] }]],
            },
          ],
        ],
      },
    ]);
  });

  it("parses a blockquote", () => {
    expect(parseMarkdown("> quoted")).toEqual([
      { kind: "quote", children: [{ kind: "paragraph", children: [text("quoted")] }] },
    ]);
  });

  it("parses a nested blockquote", () => {
    expect(parseMarkdown("> outer\n>\n> > inner")).toEqual([
      {
        kind: "quote",
        children: [
          { kind: "paragraph", children: [text("outer")] },
          { kind: "quote", children: [{ kind: "paragraph", children: [text("inner")] }] },
        ],
      },
    ]);
  });

  it("parses a table's header and rows", () => {
    expect(parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual([
      {
        kind: "table",
        head: [[text("a")], [text("b")]],
        rows: [[[text("1")], [text("2")]]],
      },
    ]);
  });

  it("parses a table with several rows", () => {
    expect(parseMarkdown("| h |\n| --- |\n| one |\n| two |")).toEqual([
      { kind: "table", head: [[text("h")]], rows: [[[text("one")]], [[text("two")]]] },
    ]);
  });

  it("keeps inline formatting inside a table cell", () => {
    expect(parseMarkdown("| a |\n| --- |\n| `x` |")).toEqual([
      { kind: "table", head: [[text("a")]], rows: [[[{ kind: "code", text: "x" }]]] },
    ]);
  });

  it("keeps a list beside its neighbours in document order", () => {
    const kinds = parseMarkdown("# t\n\n- a\n\n> q\n\npara").map((block) => block.kind);
    expect(kinds).toEqual(["heading", "list", "quote", "paragraph"]);
  });
});

describe("parseMarkdown — task lists", () => {
  it("parses an unchecked task item", () => {
    expect(parseMarkdown("- [ ] todo")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "paragraph", children: [text("todo")] }]],
        checked: [false],
      },
    ]);
  });

  it("parses a checked task item", () => {
    expect(parseMarkdown("- [x] done")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "paragraph", children: [text("done")] }]],
        checked: [true],
      },
    ]);
  });

  it("accepts an uppercase X", () => {
    expect(parseMarkdown("- [X] done")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "paragraph", children: [text("done")] }]],
        checked: [true],
      },
    ]);
  });

  it("mixes task and non-task items in one list, aligned by index", () => {
    const blocks = parseMarkdown("- [ ] a\n- plain\n- [x] b");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ kind: "paragraph", children: [text("a")] }],
          [{ kind: "paragraph", children: [text("plain")] }],
          [{ kind: "paragraph", children: [text("b")] }],
        ],
        checked: [false, undefined, true],
      },
    ]);
  });

  // No task items at all — checked is omitted entirely, not sent as an
  // all-undefined array, so every list fixture written before task lists
  // existed keeps matching exactly.
  it("omits checked entirely for a plain list", () => {
    const blocks = parseMarkdown("- a\n- b");
    expect(blocks[0]).not.toHaveProperty("checked");
  });

  it("does not treat an ordered list's numbering as a task marker", () => {
    const blocks = parseMarkdown("1. [ ]  looks odd but is not a task\n2. second");
    expect(blocks[0]).not.toHaveProperty("checked");
  });

  // The bracket text is stripped from the rendered content — a real
  // checkbox glyph replaces it, so the raw "[ ]"/"[x]" must not also
  // appear as visible words.
  it("strips the bracket marker from the item's own text", () => {
    const blocks = parseMarkdown("- [x] Modules/Listing/app/Enums/ListingAddonType.php — done");
    expect(blocks[0]).toMatchObject({
      items: [
        [
          {
            kind: "paragraph",
            children: [text("Modules/Listing/app/Enums/ListingAddonType.php — done")],
          },
        ],
      ],
    });
  });

  it("keeps a nested list beside a task list correctly, without cross-contaminating checked arrays", () => {
    const blocks = parseMarkdown("- [x] outer\n  - inner");
    const outer = blocks[0];
    expect(outer).toMatchObject({ kind: "list", checked: [true] });
    const nested = (outer as { items: unknown[][] }).items[0]?.[1];
    expect(nested).not.toHaveProperty("checked");
  });
});

describe("findTaskMarkerOffsets", () => {
  it("finds no offsets in a document with no task markers", () => {
    expect(findTaskMarkerOffsets("just a line\n- a plain item")).toEqual([]);
  });

  it("finds the state-character offset of one unchecked marker", () => {
    const text = "- [ ] todo";
    const offsets = findTaskMarkerOffsets(text);
    expect(offsets).toHaveLength(1);
    expect(text[offsets[0] as number]).toBe(" ");
  });

  it("finds the state-character offset of one checked marker", () => {
    const text = "- [x] done";
    const offsets = findTaskMarkerOffsets(text);
    expect(text[offsets[0] as number]).toBe("x");
  });

  it("finds every marker in document order", () => {
    const text = "- [ ] a\n- [x] b\n- [X] c";
    const offsets = findTaskMarkerOffsets(text);
    expect(offsets.map((index) => text[index])).toEqual([" ", "x", "X"]);
  });

  it("finds markers indented under a parent item", () => {
    const text = "- outer\n  - [x] inner";
    const offsets = findTaskMarkerOffsets(text);
    expect(offsets).toHaveLength(1);
    expect(text[offsets[0] as number]).toBe("x");
  });

  it("accepts *, - and + bullets alike", () => {
    const text = "* [ ] a\n- [ ] b\n+ [ ] c";
    expect(findTaskMarkerOffsets(text)).toHaveLength(3);
  });

  // GFM task lists are unordered-only, matching the parser's own
  // ordered ? undefined : ... restriction — a numbered list's "1." must
  // never be scanned as a task marker.
  it("ignores an ordered list's numbering", () => {
    const text = "1. [ ] looks odd but is not a task";
    expect(findTaskMarkerOffsets(text)).toEqual([]);
  });

  it("flipping the character at an offset toggles just that marker", () => {
    const text = "- [ ] a\n- [x] b";
    const [first, second] = findTaskMarkerOffsets(text);
    const flipped =
      text.slice(0, first as number) + "x" + text.slice((first as number) + 1);
    expect(flipped).toBe("- [x] a\n- [x] b");
    expect(flipped[second as number]).toBe("x");
  });
});
