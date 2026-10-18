import { shouldTrigger } from "./trigger.js";
import { prKey, reviewCommentKey } from "./types.js";
import type { PullRequest, ReviewsConfig, ReviewsGh, ReviewsStore } from "./types.js";

export type ReviewEvent =
  | { kind: "status"; status: Awaited<ReturnType<ReviewsGh["status"]>> }
  | { kind: "comments"; prKey: string; added: number }
  | { kind: "review-requested"; pr: PullRequest }
  | { kind: "prs"; prs: PullRequest[] };

type Options = {
  gh: ReviewsGh;
  store: ReviewsStore;
  config: () => ReviewsConfig;
  repos: () => string[];
  schedule: (fn: () => void, ms: number) => () => void;
  now: () => number;
  onEvent: (event: ReviewEvent) => void;
};

export function createReviewPoller({ gh, store, config, repos, schedule, now, onEvent }: Options) {
  const retryAt = new Map<string, number>();
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
      if (now() < (retryAt.get(normalized) ?? 0)) continue;
      const firstRun = await store.isFirstRun(normalized);
      const tickAt = now();
      const listed = await gh.listPrs(repo, status.login);
      prs.push(...listed);
      let complete = true;
      for (const pr of listed) {
        const key = prKey(pr.repo, pr.number);
        if (pr.role === "review-requested" && !(await store.wasNotified(key))) {
          await store.markNotified(key);
          onEvent({ kind: "review-requested", pr });
        }
        const cursor = await store.cursor(key);
        const result = await gh.listComments(pr, cursor ?? {});
        if (result.kind === "rate-limited") {
          retryAt.set(normalized, result.retryAt);
          complete = false;
          break;
        }
        if (result.kind === "unchanged") {
          if (!cursor) await store.setCursor(key, { since: tickAt });
          continue;
        }
        if (result.remainingRatio !== undefined && result.remainingRatio < 0.1) lowQuota = true;
        const existing = new Set(
          (await store.thread(key)).map((entry) =>
            reviewCommentKey(key, entry.comment.kind, entry.comment.id),
          ),
        );
        let added = 0;
        for (const comment of result.comments) {
          const id = reviewCommentKey(key, comment.kind, comment.id);
          // Upsert refreshes edited text while preserving the stored state.
          if (existing.has(id) || firstRun || !cursor || comment.createdAt <= cursor.since) {
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
          since: Math.max(cursor?.since ?? tickAt, tickAt),
          etag: result.etag,
        });
        if (added > 0) onEvent({ kind: "comments", prKey: key, added });
      }
      if (firstRun && complete) await store.markSeeded(normalized, tickAt);
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
