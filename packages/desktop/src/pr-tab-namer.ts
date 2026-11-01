// A Terminal tab follows the pull request an agent opens in it: when a pane
// prints a GitHub PR URL (core's createPrUrlScanner reads it out of the raw
// TUI output), the tab is renamed "PR #N · <title>" and the pane is linked
// to that PR in Reviews, so review comments come back to the session that
// wrote the code. Reviews' own repo + branch match misses an agent working
// in a worktree; the URL in the pane's own output does not.
//
// A URL in the output is not proof the pane opened that PR — `gh pr list`,
// a changelog, a pasted review comment all print them. So gh is asked
// first, and only an open PR created in the last PR_FRESH_MS counts; and a
// link is never written over one already set (by hand, or an unlink).

import {
  createPrUrlScanner,
  prKey,
  type PrRef,
  type ReviewsConfig,
  type WorkspaceState,
} from "@jarvis/core";
import type { ShellManager } from "@jarvis/platform";
import type { ReviewService } from "./review-service.js";
import { tabOf } from "./session-tab-name.js";

/** The longest tab title this sets, ellipsis included. */
export const PR_TAB_TITLE_MAX = 40;
/** How recently a PR must have been created to count as opened here. */
export const PR_FRESH_MS = 30 * 60_000;

/** What gh says about a PR. `repo` is GitHub's own casing. */
export type PrInfo = {
  repo: string;
  number: number;
  title: string;
  state: string;
  /** Epoch ms. */
  createdAt: number;
};

export type PrTabNamerDeps = {
  shells: Pick<ShellManager, "onOutput" | "onShellExit">;
  tabs: { state(): WorkspaceState; rename(id: string, title: string): void };
  reviews: Pick<ReviewService, "link" | "trackRepo" | "pollNow">;
  /** `gh pr view`; undefined (or a rejection) when it cannot be read. */
  prInfo(repo: string, number: number): Promise<PrInfo | undefined>;
  /** Whether Reviews already holds a manual entry (a link or an unlink)
   *  for this PR, compared case-insensitively. */
  hasManualLink(key: string): Promise<boolean>;
  /** Live Reviews settings: linking needs both `enabled` and `autoLink`. */
  reviewsConfig(): Pick<ReviewsConfig, "enabled" | "autoLink">;
  now(): number;
};

export type PrTabNamer = {
  start(): void;
  stop(): void;
  /** Whether any pane of this tab has named it after a PR, so the session
   *  namer (session-tab-name.ts) leaves the tab alone. */
  isPrNamedTab(tabId: string): boolean;
  /** Resolves once every PR seen so far has been handled. */
  whenIdle(): Promise<void>;
};

export function prTabTitle(number: number, title: string | undefined): string {
  const head = `PR #${number}`;
  const clean = title?.replace(/\s+/g, " ").trim() ?? "";
  if (clean === "") return head;
  const full = `${head} · ${clean}`;
  return full.length <= PR_TAB_TITLE_MAX
    ? full
    : `${full.slice(0, PR_TAB_TITLE_MAX - 1).trimEnd()}…`;
}

export function createPrTabNamer(deps: PrTabNamerDeps): PrTabNamer {
  const scanner = createPrUrlScanner();
  /** Pane → the PR its tab is named after. */
  const named = new Map<string, string>();
  /** Pane → the newest PR seen while one was being handled (latest wins). */
  const waiting = new Map<string, PrRef>();
  /** Pane → its handling loop, one at a time per pane. */
  const running = new Map<string, Promise<void>>();
  const unsubscribers: (() => void)[] = [];
  let stopped = false;

  async function infoOf(ref: PrRef): Promise<PrInfo | undefined> {
    try {
      return await deps.prInfo(ref.repo, ref.number);
    } catch {
      return undefined;
    }
  }

  async function apply(paneKey: string, ref: PrRef): Promise<void> {
    const info = await infoOf(ref);
    if (stopped || info === undefined) return;
    if (info.state.toUpperCase() !== "OPEN") return;
    if (deps.now() - info.createdAt > PR_FRESH_MS) return;

    const key = prKey(info.repo, info.number);
    named.set(paneKey, key);
    const tabId = tabOf(deps.tabs.state(), paneKey);
    if (tabId !== undefined) deps.tabs.rename(tabId, prTabTitle(info.number, info.title));

    const cfg = deps.reviewsConfig();
    if (!cfg.enabled || !cfg.autoLink) return;
    try {
      if (await deps.hasManualLink(key)) return;
      // Polled first, so Reviews knows the PR by its canonical key.
      deps.reviews.trackRepo(info.repo);
      await deps.reviews.pollNow();
      if (stopped || named.get(paneKey) !== key) return;
      await deps.reviews.link(key, paneKey);
    } catch {
      // gh logged out or the store busy: the tab name stands, Reviews shows why.
    }
  }

  function enqueue(paneKey: string, ref: PrRef): void {
    if (running.has(paneKey)) {
      waiting.set(paneKey, ref);
      return;
    }
    const loop = (async () => {
      let next: PrRef | undefined = ref;
      while (next !== undefined && !stopped) {
        await apply(paneKey, next);
        next = waiting.get(paneKey);
        waiting.delete(paneKey);
      }
    })();
    running.set(paneKey, loop);
    void loop.finally(() => running.delete(paneKey));
  }

  return {
    start() {
      if (stopped) return;
      unsubscribers.push(
        deps.shells.onOutput(({ paneKey, chunk }) => {
          if (stopped) return;
          const ref = scanner.push(paneKey, chunk);
          if (ref !== undefined) enqueue(paneKey, ref);
        }),
        deps.shells.onShellExit(({ paneKey }) => {
          scanner.forget(paneKey);
          named.delete(paneKey);
          waiting.delete(paneKey);
        }),
      );
    },
    stop() {
      stopped = true;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
    isPrNamedTab(tabId) {
      if (named.size === 0) return false;
      const state = deps.tabs.state();
      for (const paneKey of named.keys()) if (tabOf(state, paneKey) === tabId) return true;
      return false;
    },
    async whenIdle() {
      while (running.size > 0) await Promise.allSettled([...running.values()]);
    },
  };
}
