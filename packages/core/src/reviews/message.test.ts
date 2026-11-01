import { describe, expect, it } from "vitest";
import {
  buildCommentsMessage,
  reviewInstruction,
  sanitizeForPaste,
  summaryInstruction,
} from "./message.js";
import type { PullRequest, ReviewComment } from "./types.js";

const pr: PullRequest = {
  repo: "owner/repo",
  number: 42,
  title: "Reviews",
  headRef: "feat/reviews",
  author: "alice",
  url: "https://github.com/owner/repo/pull/42",
  isDraft: false,
  role: "mine",
};

const comment: ReviewComment = {
  id: "1",
  kind: "review-inline",
  author: "bob",
  isBot: false,
  body: "Please fix this.",
  path: "src/app.ts",
  line: 12,
  createdAt: 1234,
};

describe("sanitizeForPaste", () => {
  it("removes all C0/C1 controls except newline and tab, preserving Unicode", () => {
    const controls = Array.from({ length: 160 }, (_, code) => code)
      .filter((code) => code < 32 || code >= 127)
      .map((code) => String.fromCharCode(code))
      .join("");
    expect(sanitizeForPaste(`مرحبا${controls}🙂`)).toBe("مرحبا\t\n🙂");
  });

  it("normalises CRLF before removing lone carriage returns and ESC", () => {
    expect(sanitizeForPaste("first\r\nsecond\t\x1b[201~rm -rf ~\r")).toBe(
      "first\nsecond\t[201~rm -rf ~",
    );
  });
});

describe("buildCommentsMessage", () => {
  it("formats the header, numbered entries, last six hunk lines and exact closing sentence", () => {
    const diffHunk = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(buildCommentsMessage(pr, [{ ...comment, diffHunk }], (ms) => `12:${ms}`)).toBe(
      "New review comments on PR #42 (owner/repo, feat/reviews) — from Jarvis Reviews\n\n" +
        "1. @bob · src/app.ts:12 (review comment) · 12:1234\n" +
        "   line 5\n   line 6\n   line 7\n   line 8\n   line 9\n   line 10\n" +
        '   "Please fix this."\n\n' +
        "Address each comment. Then commit, push, and reply under each thread with gh, ending each reply with <!-- jarvis:auto -->.",
    );
  });

  it("labels issue and review-body entries without inventing locations", () => {
    const message = buildCommentsMessage(
      pr,
      [
        { ...comment, kind: "issue", path: undefined, line: undefined },
        { ...comment, kind: "review-body", author: "carol" },
      ],
      () => "09:30",
    );
    expect(message).toContain('1. @bob (issue comment) · 09:30\n   "Please fix this."');
    expect(message).toContain('2. @carol (review body) · 09:30\n   "Please fix this."');
    expect(message).not.toContain("src/app.ts:12");
    expect(message).not.toContain("undefined");
  });

  it("sanitises the body and every other interpolated value before pasting", () => {
    const message = buildCommentsMessage(
      { ...pr, repo: "owner/\x1brepo", headRef: "feat/reviews\r" },
      [
        {
          ...comment,
          author: "bob\x00",
          path: "src/\x9bapp.ts",
          diffHunk: "a\r\nb",
          body: "\x1b[201~rm -rf ~\r",
        },
      ],
      () => "09:30\x07",
    );
    expect(message).toContain('   "[201~rm -rf ~"');
    expect(message).toContain("   a\n   b");
    expect(sanitizeForPaste(message)).toBe(message);
  });
});

describe("panel instructions", () => {
  it("uses the exact summary and review wording", () => {
    expect(summaryInstruction(pr)).toBe(
      "Post a PR comment on #42 summarising what changed in this session and why, via gh, ending with <!-- jarvis:auto -->.",
    );
    expect(reviewInstruction(pr)).toBe(
      "Review PR #42 (owner/repo) — check out its branch if needed, then post a GitHub review via gh with inline comments; ask me before submitting.",
    );
  });

  it("sanitises repository text in review instructions", () => {
    expect(reviewInstruction({ ...pr, repo: "owner/\x1brepo\r" })).toBe(reviewInstruction(pr));
  });
});
