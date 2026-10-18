import type { PullRequest } from "@jarvis/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGhReviews } from "./gh-reviews.js";
import type { GhRunner } from "./git.js";

const pr: PullRequest = {
  repo: "owner/project",
  number: 42,
  title: "Fix it",
  headRef: "fix",
  author: "alice",
  url: "https://github.com/owner/project/pull/42",
  isDraft: true,
  role: "mine",
};
const raw = {
  id: 123,
  user: { login: "reviewer", type: "Bot" },
  body: "Please fix this",
  created_at: "2026-10-18T10:00:00Z",
  submitted_at: "2026-10-18T11:00:00Z",
  path: "src/main.ts",
  line: 7,
  diff_hunk: "@@ -1 +1 @@",
  in_reply_to_id: 99,
};
function response(status: number, body: unknown = [], headers = "") {
  return {
    code: status >= 400 ? 1 : 0,
    stdout: `HTTP/2.0 ${status}\r\n${headers}\r\n\r\n${JSON.stringify(body)}`,
    stderr: "",
  };
}
function client(gh: GhRunner) {
  return createGhReviews({ gh, stdinGh: async () => response(201, raw) });
}

afterEach(() => vi.restoreAllMocks());

describe("createGhReviews", () => {
  it("reports missing gh separately from logged-out auth", async () => {
    expect(
      await client(async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }).status(),
    ).toEqual({ kind: "no-gh" });
    expect(
      await client(async () => ({ code: 1, stdout: "", stderr: "login required" })).status(),
    ).toEqual({ kind: "logged-out" });
  });

  it("reads the authenticated login and repository in its cwd", async () => {
    const gh = vi.fn<GhRunner>(async (args) => ({
      code: 0,
      stdout:
        args[0] === "auth"
          ? ""
          : args[1] === "user"
            ? '{"login":"alice"}'
            : '{"nameWithOwner":"owner/project"}',
      stderr: "",
    }));
    const api = client(gh);
    expect(await api.status()).toEqual({ kind: "ok", login: "alice" });
    expect(await api.repoOf("/project")).toBe("owner/project");
    expect(gh).toHaveBeenLastCalledWith(["repo", "view", "--json", "nameWithOwner"], "/project");
    expect(
      await client(async () => ({ code: 1, stdout: "", stderr: "no repo" })).repoOf("/other"),
    ).toBeUndefined();
  });

  it("maps authored PRs and review requests with explicit JSON fields", async () => {
    const gh = vi.fn<GhRunner>(async () => ({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 42,
          title: "Fix it",
          headRefName: "fix",
          author: { login: "alice" },
          url: pr.url,
          isDraft: true,
        },
      ]),
      stderr: "",
    }));
    expect(await client(gh).listPrs(pr.repo, "alice")).toEqual([
      pr,
      { ...pr, role: "review-requested" },
    ]);
    expect(gh.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["--author", "alice", "--repo", pr.repo, "--state", "open", "--json"]),
    );
    expect(gh.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(["--search", "review-requested:alice"]),
    );
  });

  it("returns unchanged only when every endpoint returns 304", async () => {
    expect(await client(async () => response(304)).listComments(pr, { etag: '"old"' })).toEqual({
      kind: "unchanged",
    });
  });

  it("uses Retry-After seconds for a 403", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    expect(
      await client(async () => response(403, {}, "Retry-After: 60")).listComments(pr, {}),
    ).toEqual({ kind: "rate-limited", retryAt: 160_000 });
  });

  it("uses the rate reset when throttled without Retry-After", async () => {
    expect(
      await client(async () =>
        response(429, {}, "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 200"),
      ).listComments(pr, {}),
    ).toEqual({ kind: "rate-limited", retryAt: 200_000 });
  });

  it("surfaces permission 403 responses with remaining quota", async () => {
    await expect(
      client(async () =>
        response(403, { message: "Resource not accessible" }, "X-RateLimit-Remaining: 100"),
      ).listComments(pr, {}),
    ).rejects.toThrow("gh API HTTP 403");
  });

  it("treats a 403 with exhausted quota as rate-limited", async () => {
    expect(
      await client(async () =>
        response(403, {}, "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: 200"),
      ).listComments(pr, {}),
    ).toEqual({ kind: "rate-limited", retryAt: 200_000 });
  });

  it("recognizes rate limit text case-insensitively in a 403 body", async () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    expect(
      await client(async () =>
        response(403, { message: "Secondary RATE LIMIT exceeded" }),
      ).listComments(pr, {}),
    ).toEqual({ kind: "rate-limited", retryAt: 160_000 });
  });

  it("ignores malformed JSON cursors and fetches without validators", async () => {
    const gh = vi.fn<GhRunner>(async () => response(200));
    expect(await client(gh).listComments(pr, { etag: "{invalid" })).toMatchObject({
      kind: "ok",
      comments: [],
    });
    expect(gh).toHaveBeenCalledTimes(3);
    for (const [args] of gh.mock.calls) expect(args).not.toContain("-H");
  });

  it.each(["1/../../user/repos", "-1", "1.5", "", "1?x=2", "1\n"])(
    "rejects invalid comment ID %j without running gh",
    async (commentId) => {
      const gh = vi.fn<GhRunner>();
      const stdinGh = vi.fn<GhRunner>();
      const api = createGhReviews({ gh, stdinGh });
      await expect(async () => api.replyToReviewComment(pr, commentId, "body")).rejects.toThrow(
        "Invalid comment ID",
      );
      expect(gh).not.toHaveBeenCalled();
      expect(stdinGh).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...pr, repo: "owner/project/../../user/repos" },
    { ...pr, repo: "owner" },
    { ...pr, repo: "owner/project?x=2" },
    { ...pr, repo: "owner/project\n" },
    { ...pr, number: -1 },
    { ...pr, number: 1.5 },
    { ...pr, number: NaN },
    { ...pr, number: "1/../../user/repos" as unknown as number },
  ])("rejects invalid PR path inputs %j before reads or writes", async (invalidPr) => {
    const gh = vi.fn<GhRunner>();
    const stdinGh = vi.fn<GhRunner>();
    const api = createGhReviews({ gh, stdinGh });
    await expect(api.listComments(invalidPr, {})).rejects.toThrow("Invalid");
    await expect(async () => api.postComment(invalidPr, "body")).rejects.toThrow("Invalid");
    await expect(async () => api.replyToReviewComment(invalidPr, "99", "body")).rejects.toThrow(
      "Invalid",
    );
    expect(gh).not.toHaveBeenCalled();
    expect(stdinGh).not.toHaveBeenCalled();
  });

  it("maps all comment kinds, drops empty reviews and reports remaining ratio", async () => {
    const gh = vi.fn<GhRunner>(async (args) =>
      response(
        200,
        args[2]?.includes("/reviews") ? [raw, { ...raw, body: "  " }] : [raw],
        'ETag: W/"fresh"\r\nX-RateLimit-Remaining: 50\r\nX-RateLimit-Limit: 5000',
      ),
    );
    const result = await client(gh).listComments(pr, { since: 1000 });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.remainingRatio).toBe(0.01);
    expect(result.etag).toBeDefined();
    expect(result.comments).toEqual([
      {
        id: "123",
        kind: "issue",
        author: "reviewer",
        isBot: true,
        body: raw.body,
        createdAt: 1792317600000,
      },
      {
        id: "123",
        kind: "review-inline",
        author: "reviewer",
        isBot: true,
        body: raw.body,
        createdAt: 1792317600000,
        path: raw.path,
        line: 7,
        diffHunk: raw.diff_hunk,
        inReplyTo: "99",
      },
      {
        id: "123",
        kind: "review-body",
        author: "reviewer",
        isBot: true,
        body: raw.body,
        createdAt: 1792321200000,
      },
    ]);
    const conditional = vi.fn<GhRunner>(async (args) =>
      args[2]?.includes("/reviews") ? response(200, [raw]) : response(304),
    );
    const next = await client(conditional).listComments(pr, { since: 1000, etag: result.etag });
    expect(next.kind === "ok" && next.comments.map((c) => c.kind)).toEqual(["review-body"]);
    expect(
      conditional.mock.calls.every(([args]) => args.includes('If-None-Match: W/"fresh"')),
    ).toBe(true);
  });

  it("follows comment pagination", async () => {
    const gh = vi.fn<GhRunner>(async (args) =>
      args[2]?.includes("page=2")
        ? response(200, [{ ...raw, id: 124 }])
        : args[2]?.includes("/issues/")
          ? response(
              200,
              [raw],
              'Link: <https://api.github.com/repos/owner/project/issues/42/comments?per_page=100&page=2>; rel="next"',
            )
          : response(200),
    );
    const result = await client(gh).listComments(pr, {});
    expect(result.kind === "ok" && result.comments.map((c) => c.id)).toEqual(["123", "124"]);
  });

  it("keeps post and reply bodies exclusively in stdin JSON", async () => {
    const stdinGh = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(raw), stderr: "" }));
    const api = createGhReviews({ gh: async () => response(200), stdinGh });
    const body = 'secret `$(shell)`\n"quoted"';
    expect((await api.postComment(pr, body)).kind).toBe("issue");
    expect((await api.replyToReviewComment(pr, "99", body)).kind).toBe("review-inline");
    for (const call of stdinGh.mock.calls as unknown as [string[], string, string][]) {
      expect(call[0]).toEqual(expect.arrayContaining(["--input", "-"]));
      expect(call[0].join(" ")).not.toContain(body);
      expect(JSON.parse(call[2])).toEqual({ body });
    }
  });

  it("surfaces API failures instead of treating them as empty comments", async () => {
    await expect(
      client(async () => response(500, { message: "failure" })).listComments(pr, {}),
    ).rejects.toThrow("500");
  });
});
