import { describe, expect, it } from "vitest";
import { parsePlan } from "./blocks.js";
import {
  anchorComments,
  formatFeedback,
  type AnchoredComment,
  type PlanComment,
} from "./comments.js";

function comment(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: "comment-1",
    path: "/plans/release.md",
    blockId: "original-block",
    quote: "",
    body: "Please revise this.",
    createdAt: 100,
    ...overrides,
  };
}

describe("anchorComments", () => {
  it("anchors by exact block id before considering the quote", () => {
    const blocks = parsePlan("# Exact section\n\nA different quoted passage lives here.\n");
    const exact = blocks[0];
    if (exact === undefined) throw new Error("expected heading block");

    const [anchored] = anchorComments(
      [comment({ blockId: exact.id, quote: "different quoted passage" })],
      blocks,
    );

    expect(anchored?.anchor).toEqual({
      kind: "block",
      blockId: exact.id,
      text: "Exact section",
    });
  });

  it("falls back to the first block whose stripped text contains an 8-character quote", () => {
    const blocks = parsePlan(
      "# Renamed heading\n\n- **Alpha** item\n- `Quoted passage` survives an edit.\n",
    );

    const [anchored] = anchorComments(
      [comment({ blockId: "stale-block-id", quote: "Quoted passage" })],
      blocks,
    );

    expect(anchored?.blockId).toBe("stale-block-id");
    expect(anchored?.anchor).toEqual({
      kind: "block",
      blockId: blocks[1]?.id,
      text: "Alpha item\nQuoted passage survives an edit.",
    });
  });

  it("marks a comment orphaned when neither id nor eligible quote matches", () => {
    const blocks = parsePlan("Current section text.\n");

    expect(
      anchorComments([comment({ blockId: "gone", quote: "short" })], blocks)[0]?.anchor,
    ).toEqual({ kind: "orphaned" });
  });

  it("ignores a 7-character quote as too short for fallback matching, even if present verbatim", () => {
    const blocks = parsePlan("Some example text lives here.\n");

    expect(
      anchorComments([comment({ blockId: "stale-id", quote: "example" })], blocks)[0]?.anchor,
    ).toEqual({ kind: "orphaned" });
  });

  it("uses an 8-character quote for fallback matching", () => {
    const blocks = parsePlan("Some examples text lives here.\n");

    expect(
      anchorComments([comment({ blockId: "stale-id", quote: "examples" })], blocks)[0]?.anchor,
    ).toEqual({ kind: "block", blockId: blocks[0]?.id, text: "Some examples text lives here." });
  });

  it("marks an eligible (>=8 char) quote orphaned when it is simply absent from every block", () => {
    const blocks = parsePlan("Current section text.\n");

    expect(
      anchorComments([comment({ blockId: "gone", quote: "nonexistent phrase" })], blocks)[0]
        ?.anchor,
    ).toEqual({ kind: "orphaned" });
  });

  it("re-anchors a snake_case quote after the block text strips underscores", () => {
    const blocks = parsePlan(
      "# New heading\n\nUse snake_case naming for the new_helper function.\n",
    );
    const paragraph = blocks[1];
    if (paragraph === undefined) throw new Error("expected paragraph block");

    const [anchored] = anchorComments(
      [comment({ blockId: "stale-id", quote: "new_helper function" })],
      blocks,
    );

    expect(anchored?.anchor).toEqual({
      kind: "block",
      blockId: paragraph.id,
      text: "Use snakecase naming for the newhelper function.",
    });
  });

  it('re-anchors an "issue #10" quote after the block text strips the "#"', () => {
    const blocks = parsePlan("# Notes\n\nSee issue #10 for context on the regression.\n");
    const paragraph = blocks[1];
    if (paragraph === undefined) throw new Error("expected paragraph block");

    const [anchored] = anchorComments(
      [comment({ blockId: "stale-id", quote: "issue #10 for context" })],
      blocks,
    );

    expect(anchored?.anchor).toEqual({
      kind: "block",
      blockId: paragraph.id,
      text: "See issue 10 for context on the regression.",
    });
  });

  it("numbers comments in createdAt order without mutating the input order", () => {
    const blocks = parsePlan("A section long enough to quote.\n");
    const later = comment({ id: "later", createdAt: 200 });
    const earlier = comment({ id: "earlier", createdAt: 100 });
    const comments = [later, earlier];

    const anchored = anchorComments(comments, blocks);

    expect(anchored.map(({ id, number }) => [id, number])).toEqual([
      ["earlier", 1],
      ["later", 2],
    ]);
    expect(comments).toEqual([later, earlier]);
  });
});

describe("formatFeedback", () => {
  it("formats quoted and section comments with blank lines and multiline bodies", () => {
    const comments: AnchoredComment[] = [
      {
        ...comment({ quote: "the release checklist", body: "Add an owner.", createdAt: 10 }),
        number: 1,
        anchor: { kind: "block", blockId: "block-1", text: "Release checklist" },
      },
      {
        ...comment({
          id: "comment-2",
          body: "Clarify the rollback step.\nInclude the exact command.",
          createdAt: 20,
        }),
        number: 2,
        anchor: {
          kind: "block",
          blockId: "block-2",
          text: "Deployment and rollback instructions that deliberately exceed sixty characters total",
        },
      },
    ];

    expect(formatFeedback("/plans/release.md", comments)).toBe(
      [
        "Comments on /plans/release.md:",
        "",
        '1. On "the release checklist": Add an owner.',
        "",
        '2. On the section "Deployment and rollback instructions that deliberately excee": Clarify the rollback step.',
        "Include the exact command.",
        "",
        "Please update the plan to address these.",
      ].join("\n"),
    );
  });

  it("describes an orphaned comment with no quote as removed", () => {
    const orphaned: AnchoredComment = {
      ...comment(),
      number: 1,
      anchor: { kind: "orphaned" },
    };

    expect(formatFeedback("/plans/release.md", [orphaned])).toContain(
      "1. On a removed section: Please revise this.",
    );
  });

  it("throws for an empty comment list", () => {
    expect(() => formatFeedback("/plans/release.md", [])).toThrowError("no comments");
  });

  it("truncates quotes longer than 200 characters with an ellipsis", () => {
    const longQuote = "q".repeat(201);
    const anchored: AnchoredComment = {
      ...comment({ quote: longQuote }),
      number: 1,
      anchor: { kind: "orphaned" },
    };

    const result = formatFeedback("/plans/release.md", [anchored]);
    expect(result).toContain(`On "${"q".repeat(200)}…": Please revise this.`);
    expect(result).not.toContain(`"${longQuote}"`);
  });

  it("does not truncate or add an ellipsis to a quote of exactly 200 characters", () => {
    const quote = "q".repeat(200);
    const anchored: AnchoredComment = {
      ...comment({ quote }),
      number: 1,
      anchor: { kind: "orphaned" },
    };

    const result = formatFeedback("/plans/release.md", [anchored]);
    expect(result).toContain(`On "${quote}": Please revise this.`);
    expect(result).not.toContain("…");
  });

  it("does not split a surrogate pair when a 200-char quote cut would land inside one", () => {
    // 199 ASCII code points + one emoji code point = 200 code points, but
    // 201 UTF-16 code units — the old `.length > 200` check (UTF-16 units)
    // would have sliced at unit index 200, right through the emoji's
    // surrogate pair.
    const quote = `${"q".repeat(199)}\u{1F389}`;
    const anchored: AnchoredComment = {
      ...comment({ quote }),
      number: 1,
      anchor: { kind: "orphaned" },
    };

    const result = formatFeedback("/plans/release.md", [anchored]);
    expect(result).toContain(`On "${quote}": Please revise this.`);
    expect(result).not.toContain("…");
  });

  it("collapses a multi-line block's whitespace before slicing the 60-char section excerpt", () => {
    const text =
      "Deployment steps\n\n1. Build the release artifact\n2. Push it to staging for validation";
    const collapsed = text.replace(/\s+/g, " ").trim();
    const anchored: AnchoredComment = {
      ...comment(),
      number: 1,
      anchor: { kind: "block", blockId: "block-1", text },
    };

    const result = formatFeedback("/plans/release.md", [anchored]);
    expect(result).toContain(`1. On the section "${collapsed.slice(0, 60)}"`);
    expect(result).not.toMatch(/On the section "[^"]*\n/);
  });

  it("does not split a surrogate pair when the 60-char section excerpt is truncated", () => {
    // The emoji is the 60th code point — the old `.slice(0, 60)` (UTF-16
    // units) would have kept the 59 leading a's plus only the emoji's high
    // surrogate.
    const text = `${"a".repeat(59)}\u{1F389} trailing text that pushes the block past sixty characters total`;
    const expectedExcerpt = [...text].slice(0, 60).join("");
    const anchored: AnchoredComment = {
      ...comment(),
      number: 1,
      anchor: { kind: "block", blockId: "block-1", text },
    };

    const result = formatFeedback("/plans/release.md", [anchored]);
    expect(result).toContain(`On the section "${expectedExcerpt}"`);
  });
});
