import type { PlanBlock } from "./blocks.js";

export type PlanComment = {
  id: string;
  path: string;
  blockId: string;
  quote: string;
  body: string;
  createdAt: number;
  sentAt?: number;
};

export type AnchoredComment = PlanComment & {
  number: number;
  anchor: { kind: "block"; blockId: string; text: string } | { kind: "orphaned" };
};

function plainText(source: string): string {
  return source
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}(?:\s+|$)/, "")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
        .replace(/^\[[ xX]\]\s*/, "")
        .replace(/[#*_`]/g, ""),
    )
    .join("\n");
}

export function anchorComments(comments: PlanComment[], blocks: PlanBlock[]): AnchoredComment[] {
  const blocksWithText = blocks.map((block) => ({ block, text: plainText(block.source) }));

  return comments
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value.createdAt - b.value.createdAt || a.index - b.index)
    .map(({ value }, index) => {
      const exact = blocksWithText.find(({ block }) => block.id === value.blockId);
      const match =
        exact ??
        (value.quote.length >= 8
          ? blocksWithText.find(({ text }) => text.includes(value.quote))
          : undefined);

      return {
        ...value,
        number: index + 1,
        anchor:
          match === undefined
            ? { kind: "orphaned" }
            : { kind: "block", blockId: match.block.id, text: match.text },
      };
    });
}

export function formatFeedback(path: string, comments: AnchoredComment[]): string {
  if (comments.length === 0) throw new Error("no comments");

  const entries = comments.map((comment) => {
    if (comment.quote !== "") {
      const quote = comment.quote.length > 200 ? `${comment.quote.slice(0, 200)}…` : comment.quote;
      return `${comment.number}. On "${quote}": ${comment.body}`;
    }

    if (comment.anchor.kind === "orphaned") {
      return `${comment.number}. On a removed section: ${comment.body}`;
    }

    return `${comment.number}. On the section "${comment.anchor.text.slice(0, 60)}": ${comment.body}`;
  });

  return [
    `Comments on ${path}:`,
    "",
    entries.join("\n\n"),
    "",
    "Please update the plan to address these.",
  ].join("\n");
}
