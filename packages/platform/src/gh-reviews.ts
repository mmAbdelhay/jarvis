import type { PullRequest, ReviewComment, ReviewsGh } from "@jarvis/core";
import type { GhRunner } from "./git.js";

type GhComment = {
  id: number;
  user: { login: string; type: string };
  body: string | null;
  created_at?: string;
  submitted_at?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string;
  in_reply_to_id?: number;
};
type GhPr = {
  number: number;
  title: string;
  headRefName: string;
  author: { login: string };
  url: string;
  isDraft: boolean;
};
type PageCursor = { etag?: string; next?: string };

function validatePathPart(value: string, pattern: RegExp, label: string): void {
  if (typeof value !== "string" || pattern.exec(value)?.[0] !== value) {
    throw new Error(`Invalid ${label}`);
  }
}

function validatePr(pr: PullRequest): void {
  validatePathPart(pr.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repository");
  validatePathPart(String(pr.number), /^\d+$/, "PR number");
}

function comment(value: GhComment, kind: ReviewComment["kind"]): ReviewComment {
  return {
    id: String(value.id),
    kind,
    author: value.user.login,
    isBot: value.user.type === "Bot",
    body: value.body ?? "",
    createdAt: Date.parse((kind === "review-body" ? value.submitted_at : value.created_at) ?? ""),
    ...(kind === "review-inline"
      ? {
          path: value.path,
          line: value.line ?? value.original_line ?? undefined,
          diffHunk: value.diff_hunk,
          inReplyTo: value.in_reply_to_id === undefined ? undefined : String(value.in_reply_to_id),
        }
      : {}),
  };
}

/** A pagination URL gh may fetch: https://api.github.com or a relative repos/ path. */
function safeNext(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (url.startsWith("repos/")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === "api.github.com" ? url : undefined;
  } catch {
    return undefined;
  }
}

function checked(result: Awaited<ReturnType<GhRunner>>): string {
  if (result.code !== 0) throw new Error(result.stderr || `gh exited with code ${result.code}`);
  return result.stdout;
}

function parseResponse(stdout: string) {
  const separator = /\r?\n\r?\n/.exec(stdout);
  if (!separator) throw new Error("Missing gh API response headers");
  const lines = stdout.slice(0, separator.index).split(/\r?\n/);
  const status = Number(lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon !== -1) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers, body: stdout.slice(separator.index + separator[0].length) };
}

export function createGhReviews({
  gh,
  stdinGh,
}: {
  gh: GhRunner;
  stdinGh: (args: string[], cwd: string, input: string) => ReturnType<GhRunner>;
}): ReviewsGh {
  const cwd = process.cwd();
  async function post(endpoint: string, body: string, kind: ReviewComment["kind"]) {
    const result = await stdinGh(
      ["api", endpoint, "--method", "POST", "--input", "-"],
      cwd,
      JSON.stringify({ body }),
    );
    return comment(JSON.parse(checked(result)), kind);
  }
  return {
    async status() {
      try {
        const auth = await gh(["auth", "status"], cwd);
        if (auth.code !== 0) return { kind: "logged-out" };
        const user = await gh(["api", "user"], cwd);
        if (user.code !== 0) return { kind: "logged-out" };
        return { kind: "ok", login: (JSON.parse(user.stdout) as { login: string }).login };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "no-gh" };
        throw error;
      }
    },
    async repoOf(path) {
      const result = await gh(["repo", "view", "--json", "nameWithOwner"], path);
      return result.code === 0
        ? (JSON.parse(result.stdout) as { nameWithOwner: string }).nameWithOwner
        : undefined;
    },
    async listPrs(repo, login) {
      const prs: PullRequest[] = [];
      for (const role of ["mine", "review-requested"] as const) {
        const filter =
          role === "mine" ? ["--author", login] : ["--search", `review-requested:${login}`];
        const result = await gh(
          [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            ...filter,
            "--limit",
            "1000",
            "--json",
            "number,title,headRefName,author,url,isDraft",
          ],
          cwd,
        );
        for (const value of JSON.parse(checked(result)) as GhPr[]) {
          prs.push({
            repo,
            number: value.number,
            title: value.title,
            headRef: value.headRefName,
            author: value.author.login,
            url: value.url,
            isDraft: value.isDraft,
            role,
          });
        }
      }
      return prs;
    },
    async listComments(pr, cursor) {
      validatePr(pr);
      let previous: Record<string, PageCursor> = {};
      // The port has one opaque cursor; each REST page has its own validator.
      if (cursor.etag?.startsWith("{")) {
        try {
          previous = JSON.parse(cursor.etag);
        } catch {
          previous = {};
        }
      }
      const validators: Record<string, PageCursor> = {};
      const comments: ReviewComment[] = [];
      let changed = false;
      let remainingRatio: number | undefined;
      const endpoints = [
        [`issues/${pr.number}/comments`, "issue"],
        [`pulls/${pr.number}/comments`, "review-inline"],
        [`pulls/${pr.number}/reviews`, "review-body"],
      ] as const;
      for (const [path, kind] of endpoints) {
        const since =
          cursor.since !== undefined && kind !== "review-body"
            ? `&since=${encodeURIComponent(new Date(cursor.since).toISOString())}`
            : "";
        let endpoint: string | undefined = `repos/${pr.repo}/${path}?per_page=100${since}`;
        const visited = new Set<string>();
        while (endpoint && !visited.has(endpoint)) {
          visited.add(endpoint);
          const saved: PageCursor | undefined = previous[endpoint];
          const etag = saved?.etag ?? (cursor.etag?.startsWith("{") ? undefined : cursor.etag);
          const args = ["api", "-i", endpoint];
          if (etag) args.push("-H", `If-None-Match: ${etag}`);
          const result = await gh(args, cwd);
          const response = parseResponse(result.stdout);
          const { status, headers } = response;
          if (
            status === 429 ||
            (status === 403 &&
              (headers.has("retry-after") ||
                headers.get("x-ratelimit-remaining") === "0" ||
                /rate limit/i.test(response.body)))
          ) {
            const retry = headers.get("retry-after");
            const reset = headers.get("x-ratelimit-reset");
            const retryAt =
              retry !== undefined
                ? /^\d+$/.test(retry)
                  ? Date.now() + Number(retry) * 1000
                  : Date.parse(retry)
                : reset !== undefined
                  ? Number(reset) * 1000
                  : Date.now() + 60_000;
            return {
              kind: "rate-limited",
              retryAt: Number.isFinite(retryAt) ? retryAt : Date.now() + 60_000,
            };
          }
          if (status !== 304 && (status < 200 || status >= 300 || !Number.isFinite(status))) {
            throw new Error(`gh API HTTP ${status}: ${result.stderr || response.body}`);
          }
          const remaining = headers.get("x-ratelimit-remaining");
          const limit = headers.get("x-ratelimit-limit");
          if (remaining !== undefined && Number(limit) > 0) {
            const ratio = Number(remaining) / Number(limit);
            remainingRatio = Math.min(remainingRatio ?? 1, ratio);
          }
          const next: string | undefined = safeNext(
            headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ??
              (status === 304 ? saved?.next : undefined),
          );
          validators[endpoint] = {
            etag: headers.get("etag") ?? (status === 304 ? etag : undefined),
            next,
          };
          if (status !== 304) {
            checked(result);
            changed = true;
            for (const value of JSON.parse(response.body) as GhComment[]) {
              if (kind === "review-body" && !value.body?.trim()) continue;
              const mapped = comment(value, kind);
              // A pending review has no submitted_at: no time, no place in the cursor.
              if (!Number.isFinite(mapped.createdAt)) continue;
              if (
                kind === "review-body" &&
                cursor.since !== undefined &&
                mapped.createdAt < cursor.since
              )
                continue;
              comments.push(mapped);
            }
          }
          endpoint = next;
        }
      }
      return changed
        ? { kind: "ok", comments, etag: JSON.stringify(validators), remainingRatio }
        : { kind: "unchanged" };
    },
    postComment(pr, body) {
      validatePr(pr);
      return post(`repos/${pr.repo}/issues/${pr.number}/comments`, body, "issue");
    },
    replyToReviewComment(pr, commentId, body) {
      validatePr(pr);
      validatePathPart(commentId, /^\d+$/, "comment ID");
      return post(
        `repos/${pr.repo}/pulls/${pr.number}/comments/${commentId}/replies`,
        body,
        "review-inline",
      );
    },
  };
}
