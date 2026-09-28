import { describe, expect, it } from "vitest";
import { blockId, parsePlan, replaceBlock } from "./blocks.js";

describe("parsePlan — block kinds and line ranges", () => {
  const src = [
    "# Heading",
    "",
    "A paragraph.",
    "",
    "- item one",
    "- item two",
    "",
    "```js",
    "code();",
    "```",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> a quote",
    "",
    "---",
    "",
  ].join("\n");
  const blocks = parsePlan(src);

  it("produces one block per construct, in order", () => {
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "code",
      "table",
      "quote",
      "hr",
    ]);
  });

  it("gives each block markdown-it's own line range", () => {
    expect(blocks.map((b) => [b.start, b.end])).toEqual([
      [0, 1],
      [2, 3],
      [4, 7],
      [7, 10],
      [11, 14],
      [15, 16],
      [17, 18],
    ]);
  });

  it("records the heading level", () => {
    expect(blocks[0]?.level).toBe(1);
  });

  it("every other block leaves level undefined", () => {
    expect(blocks[1]?.level).toBeUndefined();
  });
});

describe("parsePlan — block ids", () => {
  it("identical paragraphs get ids suffixed -0 and -1", () => {
    const blocks = parsePlan("Same text.\n\nSame text.\n");
    const first = blocks[0];
    const second = blocks[1];
    expect(first?.id.endsWith("-0")).toBe(true);
    expect(second?.id.endsWith("-1")).toBe(true);
    expect(first?.id.split("-")[0]).toBe(second?.id.split("-")[0]);
  });

  it("editing one duplicate leaves the other's id unchanged", () => {
    const before = parsePlan("Same text.\n\nSame text.\n");
    const after = parsePlan("Same text.\n\nEdited.\n");
    expect(after[0]?.id).toBe(before[0]?.id);
  });
});

describe("replaceBlock", () => {
  const doc = `${Array.from({ length: 10 }, (_, i) => `Paragraph ${i}.`).join("\n\n")}\n`;

  it("replaces only the target block's lines; every other line is byte-identical", () => {
    const blocks = parsePlan(doc);
    const target = blocks[2];
    if (target === undefined) throw new Error("expected block 2");
    const lines = doc.split("\n");
    const result = replaceBlock(doc, target, "Replaced A.\nReplaced B.");
    const resultLines = result.split("\n");

    expect(resultLines.slice(0, target.start)).toEqual(lines.slice(0, target.start));
    const newLineCount = target.end - target.start + 1; // "Replaced A." + "Replaced B."
    expect(resultLines.slice(target.start, target.start + newLineCount)).toEqual([
      "Replaced A.",
      "Replaced B.",
    ]);
    expect(resultLines.slice(target.start + newLineCount)).toEqual(lines.slice(target.end));
  });

  it("preserves CRLF line endings outside the replaced range", () => {
    const crlf = `${Array.from({ length: 3 }, (_, i) => `Paragraph ${i}.`).join("\r\n\r\n")}\r\n`;
    const lines = crlf.split("\n");
    const blocks = parsePlan(crlf);
    const target = blocks[1];
    if (target === undefined) throw new Error("expected block 1");
    const result = replaceBlock(crlf, target, "Replaced.");
    const resultLines = result.split("\n");

    // The untouched lines — before and after the replaced block — keep their
    // original trailing \r exactly.
    expect(resultLines.slice(0, target.start)).toEqual(lines.slice(0, target.start));
    expect(resultLines.slice(target.start + 1)).toEqual(lines.slice(target.end));
    expect(resultLines[0]?.endsWith("\r")).toBe(true);
  });

  it("leaves a no-trailing-newline file without one", () => {
    const noTrailingNewline = "Paragraph 0.\n\nParagraph 1.";
    const blocks = parsePlan(noTrailingNewline);
    const last = blocks[1];
    if (last === undefined) throw new Error("expected block 1");
    const result = replaceBlock(noTrailingNewline, last, "New last.");
    expect(result.endsWith("\n")).toBe(false);
    expect(result).toBe("Paragraph 0.\n\nNew last.");
  });

  it("keeps CRLF endings inside the replaced range when the file is CRLF (textarea edits are LF)", () => {
    const crlf = "A.\r\n\r\nB.\r\n\r\nC.\r\n";
    const blocks = parsePlan(crlf);
    const target = blocks[1];
    if (target === undefined) throw new Error("expected block 1");
    const result = replaceBlock(crlf, target, "X.");
    expect(result).toBe("A.\r\n\r\nX.\r\n\r\nC.\r\n");
    // No bare \n anywhere — every \n is part of a \r\n pair.
    expect(/(?<!\r)\n/.test(result)).toBe(false);
  });

  it("does not add a stray trailing CR when a no-trailing-newline CRLF file's last block is replaced", () => {
    const crlf = "A.\r\n\r\nB.";
    const blocks = parsePlan(crlf);
    const target = blocks[1];
    if (target === undefined) throw new Error("expected block 1");
    const result = replaceBlock(crlf, target, "X.");
    expect(result).toBe("A.\r\n\r\nX.");
    expect(result.endsWith("\r")).toBe(false);
  });

  // Critical bug: parsePlan gives a list block's line range through the
  // blank line that separates it from the next block (markdown-it's own
  // token.map includes it), so `block.source` for "- a\n- b\n\npara" is
  // "- a\n- b\n" — but a converter that reconstructs a list from its own DOM
  // (plan-dom-markdown's listToMarkdown) never emits that trailing blank
  // line back. Splicing its output in naively drops the separator, and the
  // paragraph becomes a lazy continuation of the list on re-parse.
  describe("keeps the separator blank line a block's range absorbed (data-corruption fix)", () => {
    it("a list edit without the trailing blank line keeps the paragraph after it separate", () => {
      const doc = "- a\n- b\n\npara";
      const blocks = parsePlan(doc);
      const list = blocks[0];
      if (list === undefined) throw new Error("expected the list block");
      expect(list.kind).toBe("list");
      expect(list.source).toBe("- a\n- b\n"); // absorbs the blank separator line

      // The converter's real output for an edited list never carries the
      // trailing blank line — this is deliberately just "- a\n- b2".
      const result = replaceBlock(doc, list, "- a\n- b2");

      expect(result).toBe("- a\n- b2\n\npara");
      const reparsed = parsePlan(result);
      expect(reparsed.map((b) => b.kind)).toEqual(["list", "paragraph"]);
      expect(reparsed[1]?.source).toBe("para");
    });

    it("CRLF: the re-appended blank line matches the file's own line ending", () => {
      const doc = "- a\r\n- b\r\n\r\npara";
      const blocks = parsePlan(doc);
      const list = blocks[0];
      if (list === undefined) throw new Error("expected the list block");

      const result = replaceBlock(doc, list, "- a\n- b2");

      expect(result).toBe("- a\r\n- b2\r\n\r\npara");
      expect(/(?<!\r)\n/.test(result)).toBe(false);
    });

    it("a block without trailing blank lines is unchanged (no spurious blank line added)", () => {
      const doc = "Paragraph 0.\n\nParagraph 1.\n\nParagraph 2.";
      const blocks = parsePlan(doc);
      const target = blocks[1];
      if (target === undefined) throw new Error("expected block 1");
      expect(target.source).toBe("Paragraph 1."); // no trailing blank line absorbed

      const result = replaceBlock(doc, target, "Edited.");

      expect(result).toBe("Paragraph 0.\n\nEdited.\n\nParagraph 2.");
    });

    it("an edit that itself ends with extra blank lines is normalised to the original count", () => {
      const doc = "- a\n- b\n\npara";
      const blocks = parsePlan(doc);
      const list = blocks[0];
      if (list === undefined) throw new Error("expected the list block");

      // The edit text itself carries 3 trailing blank lines -- more than
      // the original range's 1 -- and must be normalised down to 1, not
      // added on top of it.
      const result = replaceBlock(doc, list, "- a\n- b2\n\n\n");

      expect(result).toBe("- a\n- b2\n\npara");
    });
  });
});

describe("parsePlan — HTML safety and links", () => {
  it("escapes a raw <script> tag instead of rendering it", () => {
    const blocks = parsePlan("Text with <script>alert(1)</script> inside.");
    expect(blocks[0]?.html).toContain("&lt;script&gt;");
    expect(blocks[0]?.html).not.toContain("<script>");
  });

  it("renders no href for a javascript: link", () => {
    const blocks = parsePlan("[x](javascript:alert(1))");
    expect(blocks[0]?.html).not.toContain("href");
  });

  it("gives every link rel=noopener noreferrer and target=_blank", () => {
    const blocks = parsePlan("[ok](https://example.com) and https://example.org bare.");
    expect(blocks[0]?.html).toContain('rel="noopener noreferrer"');
    expect(blocks[0]?.html).toContain('target="_blank"');
    expect((blocks[0]?.html.match(/<a /g) ?? []).length).toBe(2);
  });
});

describe("parsePlan — task list checkboxes", () => {
  it("renders [ ] and [x] list items as disabled checkboxes", () => {
    const blocks = parsePlan("- [ ] todo\n- [x] done\n");
    const html = blocks[0]?.html ?? "";
    expect(html).toContain('<input type="checkbox" disabled>');
    expect(html).toContain('<input type="checkbox" checked disabled>');
    expect(html).not.toContain("[ ]");
    expect(html).not.toContain("[x]");
  });
});

describe("parsePlan — lone CR does not drift line maps", () => {
  it("treats a lone \\r within a line as content, not a line break markdown-it would insert one for", () => {
    const blocks = parsePlan("A.\rstill\n\nB.\n");
    const paragraphA = blocks[0];
    const paragraphB = blocks[1];
    expect(paragraphA?.start).toBe(0);
    expect(paragraphA?.end).toBe(1);
    expect(paragraphA?.source).toBe("A.\rstill");
    expect(paragraphB?.start).toBe(2);
    expect(paragraphB?.end).toBe(3);
    expect(paragraphB?.source).toBe("B.");
  });
});

describe("blockId", () => {
  it("is pinned to a stable value so the cross-task id format can't drift", () => {
    expect(blockId("paragraph", "Hello", 0)).toBe("495b36a9-0");
  });
});

describe("parsePlan — front matter", () => {
  it("becomes a single other block rendered as <pre>", () => {
    const blocks = parsePlan("---\ntitle: x\n---\n\n# Heading\n");
    expect(blocks[0]?.kind).toBe("other");
    expect(blocks[0]?.start).toBe(0);
    expect(blocks[0]?.end).toBe(3);
    expect(blocks[0]?.html).toBe("<pre>---\ntitle: x\n---</pre>");
    expect(blocks[1]?.kind).toBe("heading");
    expect(blocks[1]?.start).toBe(4);
  });
});
