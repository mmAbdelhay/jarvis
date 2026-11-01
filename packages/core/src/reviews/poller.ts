import { shouldTrigger } from "./trigger.js";
import { prKey, reviewCommentKey } from "./types.js";
import type { PullRequest, ReviewsConfig, ReviewsGh, ReviewsStore } from "./types.js";

export type ReviewEvent =
  | { kind: "status"; status: Awaited<ReturnType<ReviewsGh["status"]>> }
  | { kind: "comments"; prKey: string; added: number }
  | { kind: "review-requested"; pr: PullRequest }
  | { kind: "prs"; prs: PullRequest[] }
  | { kind: "repo-error"; repo: string; message: string };

type Options = {
  gh: ReviewsGh;
  store: ReviewsStore;
  config: () => ReviewsConfig;
  repos: () => string[];
  schedule: (fn: () => void, ms: number) => () => void;
  now: () => number;
  onEvent: (event: ReviewEvent) => void;
};

/** A stored cursor whose time is not a finite number is treated as absent. */
function usable<T extends { since: number }>(cursor: T | undefined): T | undefined {
  return cursor !== undefined && Number.isFinite(cursor.since) ? cursor : undefined;
}

export function createReviewPoller({ gh, store, config, repos, schedule, now, onEvent }: Options) {
  const retryAt = new Map<string, number>();
  const lastPrs = new Map<string, PullRequest[]>();
  let inFlight: Promise<void> | undefined;
  let running = false;
  let cancel: (() => void) | undefined;
  let lowQuota = false;

  async function tick() {
    const cfg = config();
    if (!cfg.enabled) return;
    const status = await gh.status();
    onEvent({ kind: "status", status });
    if (status.kind !== "ok") return;
    lowQuota = false;
    const seenRepos = new Set<string>();
    const prs: PullRequest[] = [];
    for (const repo of repos()) {
      const normalized = repo.toLowerCase();
      if (seenRepos.has(normalized)) continue;
      seenRepos.add(normalized);
      if (
        Object.entries(cfg.repos).some(
          ([name, enabled]) => name.toLowerCase() === normalized && !enabled,
        )
      )
        continue;
      if (now() < (retryAt.get(normalized) ?? 0)) {
        prs.push(...(lastPrs.get(normalized) ?? []));
        continue;
      }
      try {
        const firstRun = await store.isFirstRun(normalized);
        // Reserved repo key: PrKey is a string; no store interface extension needed.
        const repoKey = `repo:${normalized}`;
        const repoCursor = usable(await store.cursor(repoKey));
        let repoSince = repoCursor?.since ?? 0;
        const listed = await gh.listPrs(repo, status.login);
        lastPrs.set(normalized, listed);
        prs.push(...listed);
        let complete = true;
        for (const pr of listed) {
          const key = prKey(pr.repo, pr.number);
          if (pr.role === "review-requested" && !(await store.wasNotified(key))) {
            await store.markNotified(key);
            onEvent({ kind: "review-requested", pr });
          }
          if (pr.role !== "mine") continue;
          const cursor = usable(await store.cursor(key));
          const previousSince = cursor?.since ?? repoCursor?.since;
          const result = await gh.listComments(pr, {
            ...cursor,
            ...(previousSince === undefined ? {} : { since: previousSince - 5 * 60 * 1000 }),
          });
          if (result.kind === "rate-limited") {
            retryAt.set(normalized, result.retryAt);
            complete = false;
            break;
          }
          if (result.kind === "unchanged") {
            if (!cursor) await store.setCursor(key, { since: previousSince ?? 0 });
            repoSince = Math.max(repoSince, previousSince ?? 0);
            continue;
          }
          if (result.remainingRatio !== undefined && result.remainingRatio < 0.1) lowQuota = true;
          const existing = new Set(
            (await store.thread(key)).map((entry) =>
              reviewCommentKey(key, entry.comment.kind, entry.comment.id),
            ),
          );
          let added = 0;
          let since = previousSince ?? 0;
          for (const comment of result.comments) {
            const timed = Number.isFinite(comment.createdAt);
            if (timed) since = Math.max(since, comment.createdAt);
            const id = reviewCommentKey(key, comment.kind, comment.id);
            // Upsert refreshes edited text while preserving the stored state.
            if (
              existing.has(id) ||
              !timed ||
              previousSince === undefined ||
              comment.createdAt <= previousSince
            ) {
              await store.upsertComments(key, [comment], "history");
            } else if (comment.author.toLowerCase() === status.login.toLowerCase()) {
              await store.markOwn(key, comment);
            } else if (shouldTrigger(comment, status.login, cfg)) {
              await store.upsertComments(key, [comment], "queued");
              added++;
            } else {
              await store.upsertComments(key, [comment], "history");
            }
            existing.add(id);
          }
          await store.setCursor(key, {
            since,
            etag: result.etag,
          });
          repoSince = Math.max(repoSince, since);
          if (added > 0) onEvent({ kind: "comments", prKey: key, added });
        }
        if (complete) {
          await store.setCursor(repoKey, { since: repoSince });
          if (firstRun) await store.markSeeded(normalized, repoSince);
        }
      } catch (error) {
        onEvent({
          kind: "repo-error",
          repo,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    onEvent({ kind: "prs", prs });
  }

  function arm() {
    if (!running) return;
    cancel = schedule(
      () => {
        cancel = undefined;
        // A transient failure must not stop background polling; manual calls reject.
        void pollNow().catch(() => {});
      },
      config().intervalSeconds * 1000 * (lowQuota ? 2 : 1),
    );
  }

  function pollNow(): Promise<void> {
    if (inFlight) return inFlight;
    cancel?.();
    cancel = undefined;
    inFlight = tick().finally(() => {
      inFlight = undefined;
      arm();
    });
    return inFlight;
  }

  return {
    start() {
      if (running) return;
      running = true;
      void pollNow().catch(() => {});
    },
    stop() {
      running = false;
      cancel?.();
      cancel = undefined;
    },
    pollNow,
  };
}
