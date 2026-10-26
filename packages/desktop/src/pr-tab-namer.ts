// A Terminal tab follows the pull request an agent opens in it: when a pane
// prints a GitHub PR URL (core's createPrUrlScanner reads it out of the raw
// TUI output), the tab is renamed "PR #N · <title>" and the pane is linked
// to that PR in Reviews, so review comments come back to the session that
// wrote the code. Reviews' own repo + branch match misses an agent working
// in a worktree; the URL in the pane's own output does not.

import { createPrUrlScanner, prKey, type PrRef, type WorkspaceState } from "@jarvis/core";
import type { ShellManager } from "@jarvis/platform";
import type { ReviewService } from "./review-service.js";
import { tabOf } from "./session-tab-name.js";

/** The longest tab title this sets, ellipsis included. */
export const PR_TAB_TITLE_MAX = 40;

export type PrTabNamerDeps = {
  shells: Pick<ShellManager, "onOutput" | "onShellExit">;
  tabs: { state(): WorkspaceState; rename(id: string, title: string): void };
  reviews: Pick<ReviewService, "link" | "trackRepo" | "pollNow">;
  /** The PR's title from GitHub; undefined when it cannot be read. */
  prTitle(repo: string, number: number): Promise<string | undefined>;
  /** Reviews switched on (live config). Off, the tab is still renamed. */
  reviewsEnabled(): boolean;
};

export type PrTabNamer = {
  start(): void;
  stop(): void;
  /** Whether this pane's tab is named after a PR, so the session namer
   *  (session-tab-name.ts) leaves it alone. */
  isPrNamed(paneKey: string): boolean;
  /** Resolves once every PR seen so far has been applied. */
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
  /** Pane → the PR its tab is named after (the latest one seen). */
  const named = new Map<string, string>();
  const inFlight = new Set<Promise<void>>();
  const unsubscribers: (() => void)[] = [];
  let stopped = false;

  async function apply(paneKey: string, ref: PrRef): Promise<void> {
    const key = prKey(ref.repo, ref.number);
    named.set(paneKey, key);
    let title: string | undefined;
    try {
      title = await deps.prTitle(ref.repo, ref.number);
    } catch {
      title = undefined;
    }
    // A newer PR in this pane, or the shell gone, while the title loaded.
    if (stopped || named.get(paneKey) !== key) return;
    const tabId = tabOf(deps.tabs.state(), paneKey);
    if (tabId !== undefined) deps.tabs.rename(tabId, prTabTitle(ref.number, title));

    if (!deps.reviewsEnabled()) return;
    deps.reviews.trackRepo(ref.repo);
    try {
      await deps.reviews.link(key, paneKey);
      await deps.reviews.pollNow();
    } catch {
      // gh missing or logged out: the tab name stands, Reviews shows why.
    }
  }

  function track(work: Promise<void>): void {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }

  return {
    start() {
      if (stopped) return;
      unsubscribers.push(
        deps.shells.onOutput(({ paneKey, chunk }) => {
          if (stopped) return;
          const ref = scanner.push(paneKey, chunk);
          if (ref !== undefined) track(apply(paneKey, ref));
        }),
        deps.shells.onShellExit(({ paneKey }) => {
          scanner.forget(paneKey);
          named.delete(paneKey);
        }),
      );
    },
    stop() {
      stopped = true;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
    isPrNamed: (paneKey) => named.has(paneKey),
    async whenIdle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
