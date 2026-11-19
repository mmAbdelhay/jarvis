// A Terminal tab follows the pull request its pane is about, from two
// sources. The tab is renamed "PR #N · <title>" and the pane is linked to
// that PR in Reviews, so review comments come back to the session there.
// Reviews' own repo + branch match misses an agent working in a worktree;
// these sources do not.
//
// 1. Output: a GitHub PR URL the pane prints (core's createPrUrlScanner
//    reads it out of the raw TUI output) — the PR an agent opened. A URL in
//    the output is not proof the pane opened that PR — `gh pr list`, a
//    changelog, a pasted review comment all print them — so only an open
//    PR created in the last PR_FRESH_MS counts.
// 2. Prompt: a PR URL in the user's own prompt to the Claude session in the
//    pane (session-tab-name.ts reads it from the transcript and calls
//    fromPrompt) — typically a PR asked for review, so it may be any age.
//    It still must be open, and each prompt PR is handled once per pane.
//
// Either way gh is asked first, the latest PR wins per pane, and a link is
// never written over one already set (by hand, or an unlink).

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
  /** A PR named in the user's own prompt in this pane: no freshness limit.
   *  The same PR reported again for the pane is not looked up again (unless
   *  gh could not say). `predatesRun`: the session was running before this
   *  run, so a tab name the user typed is kept. */
  fromPrompt(paneKey: string, ref: PrRef, opts?: { predatesRun?: boolean }): void;
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

/** A PR to handle, whether it came from the user's prompt, and whether that
 *  session was already running when this run started. */
type Seen = { ref: PrRef; fromPrompt: boolean; predatesRun?: boolean };

function promptKey(ref: PrRef): string {
  return prKey(ref.repo, ref.number).toLowerCase();
}

export function createPrTabNamer(deps: PrTabNamerDeps): PrTabNamer {
  const scanner = createPrUrlScanner();
  /** Pane → the PR its tab is named after. */
  const named = new Map<string, string>();
  /** Pane → the PR it was last matched to, named after or not (a typed
   *  name kept): the one a link in flight must still be. */
  const current = new Map<string, string>();
  /** Pane → the last prompt PR handed in, lower-cased: handled once. */
  const prompted = new Map<string, string>();
  /** Pane → the newest PR of each source seen while one was being handled,
   *  oldest first (latest wins). Per source, so a stale output URL cannot
   *  push out a prompt PR that is handled only once. */
  const waiting = new Map<string, Seen[]>();
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

  async function apply(paneKey: string, seen: Seen): Promise<void> {
    const { ref, fromPrompt } = seen;
    const info = await infoOf(ref);
    if (stopped) return;
    if (info === undefined) {
      // gh could not say (offline, logged out): the next check asks again.
      if (fromPrompt && prompted.get(paneKey) === promptKey(ref)) prompted.delete(paneKey);
      return;
    }
    if (info.state.toUpperCase() !== "OPEN") return;
    if (!fromPrompt && deps.now() - info.createdAt > PR_FRESH_MS) return;

    const key = prKey(info.repo, info.number);
    current.set(paneKey, key);
    const state = deps.tabs.state();
    const tabId = tabOf(state, paneKey);
    const title = prTabTitle(info.number, info.title);
    const customTitle = state.tabs.find((tab) => tab.id === tabId)?.customTitle;
    // A session already running when Jarvis (re)started, in a tab the user
    // named: the name stands, as session-tab-name.ts does for its names.
    // The PR is still handled, and linked below.
    const keepTyped =
      seen.predatesRun === true &&
      !named.has(paneKey) &&
      customTitle !== undefined &&
      customTitle !== title;
    if (!keepTyped) {
      named.set(paneKey, key);
      if (tabId !== undefined) deps.tabs.rename(tabId, title);
    }

    const cfg = deps.reviewsConfig();
    if (!cfg.enabled || !cfg.autoLink) return;
    try {
      if (await deps.hasManualLink(key)) return;
      // Polled first, so Reviews knows the PR by its canonical key.
      deps.reviews.trackRepo(info.repo);
      await deps.reviews.pollNow();
      if (stopped || current.get(paneKey) !== key) return;
      await deps.reviews.link(key, paneKey);
    } catch {
      // gh logged out or the store busy: the tab name stands, Reviews shows why.
    }
  }

  function enqueue(paneKey: string, seen: Seen): void {
    if (running.has(paneKey)) {
      const queue = (waiting.get(paneKey) ?? []).filter((s) => s.fromPrompt !== seen.fromPrompt);
      waiting.set(paneKey, [...queue, seen]);
      return;
    }
    const loop = (async () => {
      let next: Seen | undefined = seen;
      while (next !== undefined && !stopped) {
        await apply(paneKey, next);
        const queue = waiting.get(paneKey) ?? [];
        next = queue.shift();
        if (queue.length === 0) waiting.delete(paneKey);
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
          if (ref !== undefined) enqueue(paneKey, { ref, fromPrompt: false });
        }),
        deps.shells.onShellExit(({ paneKey }) => {
          scanner.forget(paneKey);
          named.delete(paneKey);
          current.delete(paneKey);
          prompted.delete(paneKey);
          waiting.delete(paneKey);
        }),
      );
    },
    fromPrompt(paneKey, ref, opts) {
      if (stopped) return;
      const key = promptKey(ref);
      if (prompted.get(paneKey) === key) return;
      prompted.set(paneKey, key);
      enqueue(paneKey, { ref, fromPrompt: true, predatesRun: opts?.predatesRun === true });
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
