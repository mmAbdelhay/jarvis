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
});
