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

/**
 * `plainText`, collapsed to single-spaced text — comparison-only. A quote
 * captured before an edit can contain the very markdown markers (`_ # * `\``)
 * `plainText` strips from block text, and can span what used to be one line
 * but is now wrapped differently; without running both sides of the
 * `includes` check through this, a quote like "snake_case" or "issue #10"
 * never re-matches after the block's markup or line-wrapping changes. Never
 * used for a value that's displayed — `anchor.text` keeps `plainText`'s own
 * line breaks for that.
 */
function normalizedForMatch(source: string): string {
  return plainText(source).replace(/\s+/g, " ").trim();
}

export function anchorComments(comments: PlanComment[], blocks: PlanBlock[]): AnchoredComment[] {
  const blocksWithText = blocks.map((block) => ({ block, text: plainText(block.source) }));

  return comments
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value.createdAt - b.value.createdAt || a.index - b.index)
    .map(({ value }, index) => {
      const exact = blocksWithText.find(({ block }) => block.id === value.blockId);
      const normalizedQuote = normalizedForMatch(value.quote);
      const match =
        exact ??
        (normalizedQuote.length >= 8
          ? blocksWithText.find(({ text }) => normalizedForMatch(text).includes(normalizedQuote))
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

/**
 * Truncates by Unicode code point, not UTF-16 code unit, so a cut at
 * `maxLength` never lands inside a surrogate pair (an emoji or other
 * astral-plane character split this way becomes a lone, unpaired
 * surrogate — invalid UTF-16 that corrupts everything after it once
 * written out). `Array.from` iterates by code point for exactly this
 * reason. Length is compared the same way, so a string that's short in
 * code points but long in code units (surrogate pairs) isn't truncated
 * when it doesn't need to be, and vice versa.
 */
function truncateCodePoints(text: string, maxLength: number): { text: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= maxLength) return { text, truncated: false };
  return { text: points.slice(0, maxLength).join(""), truncated: true };
}

export function formatFeedback(path: string, comments: AnchoredComment[]): string {
  if (comments.length === 0) throw new Error("no comments");

  const entries = comments.map((comment) => {
    if (comment.quote !== "") {
      const { text, truncated } = truncateCodePoints(comment.quote, 200);
      const quote = truncated ? `${text}…` : text;
      return `${comment.number}. On "${quote}": ${comment.body}`;
    }

    if (comment.anchor.kind === "orphaned") {
      return `${comment.number}. On a removed section: ${comment.body}`;
    }

    // Collapsed to single-spaced text before the cut: a multi-line block's
    // own newlines would otherwise break this into more than the one line
    // `On the section "…"` is meant to be.
    const collapsed = comment.anchor.text.replace(/\s+/g, " ").trim();
    const excerpt = truncateCodePoints(collapsed, 60).text;
    return `${comment.number}. On the section "${excerpt}": ${comment.body}`;
  });

  return [
    `Comments on ${path}:`,
    "",
    entries.join("\n\n"),
    "",
    "Please update the plan to address these.",
  ].join("\n");
}
