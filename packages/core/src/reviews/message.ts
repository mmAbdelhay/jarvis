import { REVIEW_MARKER } from "./types.js";
import type { PullRequest, ReviewComment } from "./types.js";

export function sanitizeForPaste(s: string): string {
  return Array.from(s.replaceAll("\r\n", "\n"))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && (code < 127 || code > 159));
    })
    .join("");
}

const KIND_LABELS: Record<ReviewComment["kind"], string> = {
  issue: "issue comment",
  "review-inline": "review comment",
  "review-body": "review body",
};

export function buildCommentsMessage(
  pr: PullRequest,
  comments: ReviewComment[],
  fmtTime: (ms: number) => string,
): string {
  const entries = comments.map((comment, index) => {
    const location =
      comment.kind === "review-inline" && comment.path !== undefined
        ? ` · ${comment.path}${comment.line !== undefined ? `:${comment.line}` : ""}`
        : "";
    const header = `${index + 1}. @${comment.author}${location} (${KIND_LABELS[comment.kind]}) · ${fmtTime(comment.createdAt)}`;
    const hunk = comment.diffHunk
      ? sanitizeForPaste(comment.diffHunk)
          .split("\n")
          .slice(-6)
          .map((line) => `   ${line}`)
      : [];
    const body = sanitizeForPaste(comment.body).replaceAll("\n", "\n   ");
    return [header, ...hunk, `   "${body}"`].join("\n");
  });
  return sanitizeForPaste(
    [
      `New review comments on PR #${pr.number} (${pr.repo}, ${pr.headRef}) — from Jarvis Reviews`,
      ...entries,
      `Address each comment. Then commit, push, and reply under each thread with gh, ending each reply with ${REVIEW_MARKER}.`,
    ].join("\n\n"),
  );
}

export function summaryInstruction(pr: PullRequest): string {
  return sanitizeForPaste(
    `Post a PR comment on #${pr.number} summarising what changed in this session and why, via gh, ending with ${REVIEW_MARKER}.`,
  );
}

export function reviewInstruction(pr: PullRequest): string {
  return sanitizeForPaste(
    `Review PR #${pr.number} (${pr.repo}) — check out its branch if needed, then post a GitHub review via gh with inline comments; ask me before submitting.`,
  );
}
